import type {BrainPort, BrainRecord} from '../../contracts/src/index.js';
import {rankRecords, visibleLinksBetween} from '../../contracts/src/records.js';
import {noteEvidence} from './evidence.js';
import {independentNote} from './evidence-eligibility.js';

/** Request-local traversal. Connections are leads; only current source supports answers. */
export class GraphRetrieval {
  private seen = new Map<string, number>();
  private expanded = new Set<string>();
  private revisions = new Map<string, number>();
  private calls = 0;
  constructor(private brain: BrainPort, private conversationId: string, private query: string,
    private requestTurnIds: readonly string[] = []) {}
  private eligible(r: BrainRecord | undefined): r is BrainRecord {
    return independentNote(r, this.conversationId, this.requestTurnIds);
  }
  async retrieved(output: unknown) {
    for (const item of Array.isArray(output) ? output : [output]) {
      if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') continue;
      const r = await this.brain.getRecord(item.id);
      if (this.eligible(r) && !this.seen.has(r.id)) this.seen.set(r.id, 0);
    }
  }
  async expand(id: string) {
    const depth = this.seen.get(id);
    if (depth === undefined) throw Error('Retrieve the starting note in this request before following connections.');
    if (depth >= 2 || this.calls >= 2) throw Error('Graph expansion limit reached; use retrieved evidence or explain what is unresolved.');
    if (this.expanded.has(id)) throw Error('Connections already expanded; reuse the current evidence.');
    this.calls++; this.expanded.add(id); // Failed reads also consume the bounded allowance.
    const seed = await this.brain.getRecord(id);
    if (!this.eligible(seed)) throw Error('Starting note is no longer available.');
    const records = [];
    for (const candidate of await this.brain.related(id)) {
      const current = await this.brain.getRecord(candidate.id);
      if (this.eligible(current) && !this.seen.has(current.id) && this.links(seed, current).length) records.push(current);
    }
    const ranked = rankRecords(records, this.query).map(item => item.record);
    const selected = [...ranked, ...records.filter(r => !ranked.some(x => x.id === r.id))].slice(0, 5);
    this.revisions.set(seed.id, seed.revision);
    return selected.map(r => {
      this.seen.set(r.id, depth + 1); this.revisions.set(r.id, r.revision);
      return {...noteEvidence(r, 0, 1600, this.query), via: {id: seed.id, title: seed.title,
        revision: seed.revision, hop: depth + 1, relationships: this.links(seed, r)},
        evidenceNotice: 'Relationship is a retrieval lead, not proof. Use this current source excerpt.'};
    });
  }
  private links(a: BrainRecord, b: BrainRecord) {
    return visibleLinksBetween(a,b).filter(l => ['reply','correction','manual','suggested'].includes(l.provenance) &&
      (['reply','correction'].includes(l.provenance) || l.decision === 'accepted' || (l.provenance === 'manual' && !l.decision)));
  }
  async current() {
    for (const [id, revision] of this.revisions) {
      const record = await this.brain.getRecord(id);
      if (!this.eligible(record) || record.revision !== revision) return false;
    }
    return true;
  }
}
