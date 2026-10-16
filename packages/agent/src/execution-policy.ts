import type {BrainPort, ToolCall} from '../../contracts/src/index.js';
import type {EvidenceIndex, EvidenceRef} from './evidence.js';
import type {ExperimentToolEvent} from './reliability.js';

/** Isolated comparison option. Hosts deliberately do not enable it. */
export interface ResponseExecutionExperiment {
  mode: 'current' | 'balanced' | 'parallel' | 'plan_first';
  /** A lower cap is useful for safety tests; experiments can never exceed eight. */
  maxToolCalls?: number;
}
export const executionReadTools = ['search_notes', 'read_note', 'conversation_history'] as const;
export const planFirstInstruction = ' For this first response only, plan the independent parts of the current request before choosing retrieval. When multiple specific searches are independently justified, propose them together using grounded, focused queries (at most two independent reads can run concurrently). Do not invent IDs or assume a result not yet retrieved. A later read or refined query that depends on an earlier result must wait for that result. Simple questions need no extra decomposition. Then adapt to the returned evidence and answer within the same six-call allowance. This is a plan-first adaptive policy, not a separate agent or an instruction to make more calls.';

/** Counts proposals before dispatch and schedules only syntactically independent reads.
 * The Agent still validates every argument, consent, revision and cancellation guard. */
export class ExecutionPolicy {
  readonly cap: number;
  private proposed = 0;
  private groups = new Map<string, EvidenceRef[]>();
  private explicit: EvidenceRef[] = [];
  private previous: EvidenceRef[] | undefined;
  private timings: {callId: string; tool: string; startedMs: number; durationMs: number; execution: 'returned' | 'threw'}[] = [];
  private origin = performance.now();
  constructor(readonly options: ResponseExecutionExperiment) {
    if (!['current', 'balanced', 'parallel', 'plan_first'].includes(options.mode)) throw Error('Unknown execution experiment mode');
    this.cap = options.maxToolCalls ?? 8;
    if (!Number.isInteger(this.cap) || this.cap < 1 || this.cap > 8) throw Error('Execution experiment tool cap must be between one and eight');
  }
  allows(name: string) {return (executionReadTools as readonly string[]).includes(name);}
  async measure<T>(call: ToolCall, work: () => Promise<T>): Promise<T> {
    const start = performance.now(); let execution: 'returned' | 'threw' = 'threw';
    try {const result = await work(); execution = 'returned'; return result;}
    finally {this.timings.push({callId: call.id, tool: call.name, startedMs: start - this.origin,
      durationMs: performance.now() - start, execution});}
  }
  async persistTimings(brain: BrainPort, id: string) {
    await brain.setState(`execution-tool-timings:${id}`, this.timings.slice().sort((a, b) => a.startedMs - b.startedMs));
  }
  reserve(calls: ToolCall[]) {
    if (this.proposed + calls.length > this.cap) throw Error(`Execution experiment tool-proposal limit (${this.cap}) reached; remaining work is unresolved.`);
    this.proposed += calls.length;
  }
  batches(calls: ToolCall[]): ToolCall[][] {
    const output: ToolCall[][] = [];
    for (const call of calls) {
      const parallel = ['parallel', 'plan_first'].includes(this.options.mode) && this.independent(call);
      const last = output.at(-1);
      if (parallel && last?.length === 1 && this.independent(last[0]!)) last.push(call);
      else output.push([call]);
    }
    return output;
  }
  private independent(call: ToolCall) {
    // Placeholder/dependency expressions are not a supported plan format.
    return ['search_notes', 'read_note'].includes(call.name) &&
      !!call.arguments && !Object.values(call.arguments).some(value => typeof value === 'string' && /\$\{|\{\{|#E\d+|\$\w+\.results|tool_result/i.test(value));
  }
  async initializeEvidence(brain: BrainPort, id: string) {
    if (this.options.mode === 'current') return;
    const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`);
    this.previous = (index?.refs ?? []).map(ref => ({...ref, length: Math.min(2400, ref.length)}));
  }
  /** Called in proposal order after normal outcome persistence. Five passages remain
   * bounded at 2,400 characters each; no labels or expected answers affect selection. */
  async retain(brain: BrainPort, id: string, event: ExperimentToolEvent) {
    if (this.options.mode === 'current') return;
    const key = (ref: EvidenceRef) => `${ref.id}:${ref.offset}:${ref.length}`;
    if (event.status === 'success' && ['search_notes', 'read_note'].includes(event.call.name)) {
      const values = Array.isArray(event.result) ? event.result : [event.result];
      const refs: EvidenceRef[] = values.flatMap(value => {
        if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return [];
        return [{id: value.id, offset: 'offset' in value ? Number(value.offset) : Number(event.call.arguments.offset) || 0,
          length: Math.min(2400, Number(event.call.arguments.length) || 2400),
          query: typeof event.call.arguments.query === 'string' ? event.call.arguments.query : undefined}];
      });
      if (event.call.name === 'read_note') {
        for (const ref of refs) this.explicit = [...this.explicit.filter(old => key(old) !== key(ref)), ref];
      } else this.groups.set(String(event.call.arguments.query), refs);
    }
    const selected: EvidenceRef[] = [], seen = new Set<string>();
    const add = (ref: EvidenceRef | undefined) => {
      if (ref && selected.length < 5 && !seen.has(key(ref))) {selected.push(ref); seen.add(key(ref));}
    };
    // Deliberate passage reads take priority; later reads cannot erase another
    // passage of the same document merely because its note ID matches.
    this.explicit.slice(-5).forEach(add);
    const groups = [...this.groups.values()];
    for (let rank = 0; rank < 5 && selected.length < 5; rank++) for (const group of groups) add(group[rank]);
    for (const ref of this.previous ?? []) add(ref);
    const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`) ?? {refs: [], outcomes: []};
    await brain.setState(`evidence-index:${id}`, {...index, refs: selected});
  }
}
