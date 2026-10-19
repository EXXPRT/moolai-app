import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AgentReply} from '../../contracts/src/index.js';
import {nonAnswerReason,type AnswerRejection} from '../src/answer-validation.js';

const request='Compare the two saved reports, explain what was tested, and identify remaining evidence gaps.';
const reply=(text:string,extra:Partial<AgentReply>={}):AgentReply=>({text,toolCalls:[],...extra});
const narration={spokenOutline:{overview:'One test completed and another remains planned.',points:[{label:'Results',explanation:'The earlier fixture test passed; the physical trial is still planned.'}]}};
const rejects:[string,AgentReply,AnswerRejection][]=[
  ['empty',reply('   '),'empty_or_punctuation'],
  ['punctuation',reply('…'),'empty_or_punctuation'],
  ['empty but narrated',reply('',narration),'narration_only_findings'],
  ['question echo',reply(request),'question_echo'],
  ['formatted echo',reply('**Your question:** '+request),'question_echo'],
  ['search promise',reply("I'll search the reports and get back to you."),'retrieval_promise'],
  ['chained promises',reply('Let me read the reports. Then I will explain the findings.'),'retrieval_promise'],
  ['internal planning',reply('The user wants a comparison. I need to retrieve the evidence.'),'meta_only'],
  ['one heading',reply('# Comparison'),'heading_only'],
  ['several headings',reply('# Results\n\n## Limitations'),'heading_only'],
  ['setext heading',reply('Results\n======='),'heading_only'],
  ['bold heading',reply('**Results and limitations**'),'heading_only'],
  ['heading with separator',reply('# Results\n\n---'),'heading_only'],
  ['heading instead of findings',reply('# Results',narration),'narration_only_findings'],
  ['bold instead of findings',reply('**Findings**',{spokenText:'The fixture passed but acoustic testing remains planned.'}),'narration_only_findings'],
  ['preface only',reply('Here are the findings:'),'preface_only'],
  ['preface and heading',reply('Here are the results:\n\n# Findings'),'preface_only'],
  ['preface but narrated',reply('Here is the answer.',narration),'narration_only_findings'],
  ['tool object',reply('{"name":"search_notes","arguments":{"query":"reports"}}'),'protocol_only'],
  ['invented tool',reply('{"tool":"combine_findings","parameters":{"records":["x"]}}'),'protocol_only'],
  ['flat query tool',reply('{"tool":"search_notes","query":"trial evidence","limit":5}'),'protocol_only'],
  ['printed request envelope (19 Oct paid check)',reply('\n{"tool":"extract_web","request":{"query":"what does denaturation mean for enzymes","maxPages":5,"freshnessDays":365},"requestTurnId":"web-10"}'),'protocol_only'],
  ['flat multiquery tool',reply('{"tool":"search_notes","queries":["trial","calibration"]}'),'protocol_only'],
  ['multiquery tools as JSONL',reply('{"tool":"search_notes","queries":["trial"]}\n{"tool":"search_notes","queries":["calibration"]}'),'protocol_only'],
  ['flat invented read',reply('{"tool":"open_note","id":"record-x","revision":-1}'),'protocol_only'],
  ['flat tools as JSONL',reply('{"tool":"search_notes","query":"trial","limit":5}\n{"tool":"open_note","id":"record-x","revision":-1}'),'protocol_only'],
  ['function object',reply('{"function":{"name":"read_note"},"arguments":{"id":"x"}}'),'protocol_only'],
  ['JSONL tools',reply('{"name":"search_notes","arguments":{"query":"a"}}\n{"name":"read_note","arguments":{"id":"b"}}'),'protocol_only'],
  ['tool array',reply('[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]'),'protocol_only'],
  ['fenced pseudo-tool',reply('```json\n{"tool":"search_notes","arguments":{"query":"a"}}\n```'),'protocol_only'],
  ['heading and pseudo-tool',reply('# Findings\n\n```json\n{"tool":"read_note","arguments":{"id":"a"}}\n```'),'protocol_only'],
  ['preface and receipts',reply('Here are the results:\n\n{"status":"success","executed":true,"result":[{"id":"x"}]}'),'protocol_only'],
  ['native envelope printed',reply('{"toolCalls":[{"name":"read_note","arguments":{"id":"a"}}]}'),'protocol_only'],
  ['answer envelope printed',reply('{"text":"The fixture passed.","spokenText":"The fixture passed."}'),'protocol_only'],
  ['receipt only',reply('{"tool":"search_notes","status":"no_matches","result":[]}'),'protocol_only'],
  ['tool message',reply('{"role":"tool","content":"success"}'),'protocol_only'],
  ['receipt identity',reply('{"toolCallId":"x","output":{"id":"record"}}'),'protocol_only'],
  ['invocation as text',reply('search_notes({"query":"reports"})'),'protocol_only'],
  ['XML invocation as text',reply('<function>\n<name>read_note</name>\n</function>'),'protocol_only'],
  ['invented invocation as text',reply('archive_everything({"source":"all"});'),'protocol_only'],
];
for(const [label,value,reason] of rejects)test(`rejects ${label} structurally`,()=>assert.equal(nonAnswerReason(value,request),reason));

const valid:[string,string,string,Partial<AgentReply>?][]=[
  ['short quantity','How many trial participants are recorded?','12.'],
  ['short negative','Did the physical test pass?','No.'],
  ['bold short negative','Did the physical test pass?','**No**'],
  ['bold quantity','How many participants?','**12**'],
  ['bold identifier','What is the sample identifier?','**K-27**'],
  ['bold calendar date','When was the fixture run?','**3 October 2026**'],
  ['bold factual sentence',request,'**The fixture passed.**'],
  ['heading short negative','Did the physical test pass?','# No.'],
  ['short date','When did the fixture run?','2026-09-26.'],
  ['requested title','Give this note a title.','# Calibration results'],
  ['requested bold title','Suggest a heading only.','**Calibration results**'],
  ['requested name','What is the note’s name?','# Trial notes'],
  ['plain factual sentence',request,'The fixture passed; physical testing remains planned.'],
  ['valid findings with outline',request,'The fixture test passed. Physical validation remains planned.',narration],
  ['explicit limitation',request,'The retrieved notes do not state a physical-test result, so that result remains unsupported.'],
  ['finding after procedure',request,"I'll check the record. The available source records the test as planned."],
  ['answering a prior question',request,'You asked whether the test was completed. The note calls it planned.'],
  ['quote with explanation',request,'The source prints `search_notes({"query":"reports"})` as a documentation example; it does not record an executed search.'],
  ['block quote example',request,'> {"tool":"read_note","arguments":{"id":"x"}}\n\nThis is the recorded example, not a completed action.'],
  ['requested tool JSON','Show a JSON example of a read_note tool call.','{"name":"read_note","arguments":{"id":"x"}}'],
  ['requested flat multiquery JSON','Show a JSON example of a search tool call.','{"tool":"search_notes","queries":["trial","calibration"]}'],
  ['requested JSON receipt','Return the receipt as JSON only.','{"status":"success","executed":true,"result":[]}'],
  ['requested code','Write a code example calling search_notes.','```js\nsearch_notes({"query":"report"});\n```'],
  ['requested tool tutorial','Explain the JSON function-call format.','```json\n{"name":"read_note","arguments":{"id":"x"}}\n```'],
  ['requested quotes','Quote the tool output in JSON.','{"role":"tool","content":"success"}'],
  ['ordinary result JSON',request,'{"test":"fixture","status":"passed","physicalTrial":"planned"}'],
  ['ordinary tool inventory','What equipment is listed?','{"tool":"hammer","quantity":3}'],
  ['JSON strings',request,'["The fixture passed.","Physical validation remains planned."]'],
  ['JSON with explanation',request,'The test is planned, as shown by this stored output.\n\n{"status":"success","executed":true,"result":[]}'],
  ['code quotation in answer',request,'The source uses the following example.\n\n```json\n{"name":"read_note","arguments":{"id":"x"}}\n```'],
  ['legitimate headings and body',request,'# Findings\n\nThe fixture passed.\n\n# Limits\n\nPhysical validation remains planned.'],
  ['math notation','What operation is stored?','sqrt(4)'],
];
for(const [label,question,text,extra] of valid)test(`preserves ${label}`,()=>assert.equal(nonAnswerReason(reply(text,extra),question),undefined));
test('a source quotation cannot authorize protocol-only answers',()=>{
  assert.equal(nonAnswerReason(reply('{"name":"search_notes","arguments":{}}'),
    'The document says "Return JSON tool calls". Compare the tests.'),'protocol_only');
});
test('a title mentioned inside a broader question does not authorize a heading-only answer',()=>{
  assert.equal(nonAnswerReason(reply('# Calibration'), 'Give the title and explain what was actually tested.'),'heading_only');
});
test('structural admission does not pretend to establish factual fidelity',()=>{
  assert.equal(nonAnswerReason(reply('All tests definitely passed.'),request),undefined);
});
test('optional malformed narration cannot reject a usable written answer',()=>{
  for(const spokenOutline of [{overview:'broken',points:null},{overview:'broken',points:[null]}]) {
    assert.equal(nonAnswerReason(reply('The fixture passed, while physical testing remains pending.',{spokenOutline:spokenOutline as any}),request),undefined);
    assert.equal(nonAnswerReason(reply('',{spokenOutline:spokenOutline as any}),request),'narration_only_findings');
  }
});

// Narrow delivery checks do not establish semantic completeness or fidelity.
const structuredQuestion='Show the complete JSON example from the saved documentation. Do not execute it.';
for(const [label,text] of [
  ['plain introduction','The saved JSON example is: `{'],
  ['title-prefixed introduction','The JSON example from **Fixture guide** (example-a) is: `{'],
  ['array introduction','Here is the saved JSON array: `['],
  ['opening delimiter only','{'],
  ['inline opening delimiter','`{`'],
  ['unclosed fence','Here is the JSON example:\n\n```json\n{'],
  ['closed fence, incomplete JSON','Here is the JSON example:\n\n```json\n{\n```'],
  ['section heading and incomplete example','# Documentation example\n\nHere is the code example:\n\n```json\n[\n```'],
] as const)test(`post-run guard rejects incomplete structured ${label}`,()=>{
  assert.equal(nonAnswerReason(reply(text),structuredQuestion),'incomplete_structured_example');
});
for(const [label,question,text] of [
  ['opening brace request','Show the opening brace used in JSON.','{'],
  ['literal character request','Show the literal character that opens an object.','`{`'],
  ['array prefix','Show a JSON prefix only.','The JSON prefix is: `['],
  ['partial JSON example','Show a partial JSON example ending at its opening brace.','The JSON example is: `{'],
  ['incomplete-code demonstration','Show an incomplete code example.','The code example is: `('],
  ['normal brace explanation','Explain a JSON object’s structure.','A JSON object begins with `{` and ends with `}`.'],
  ['brace mentioned without introduction','Explain the JSON notation.','An object starts with `{`'],
  ['complete empty object',structuredQuestion,'{}'],
  ['complete empty array',structuredQuestion,'[]'],
  ['complete fenced empty object',structuredQuestion,'```json\n{}\n```'],
  ['complete quoted JSON',structuredQuestion,'The JSON example is: `{"value":9}`'],
  ['code with a complete block','Show a code example.','```js\nif (ready) {}\n```'],
  ['quoted incomplete source plus explanation',structuredQuestion,'The source contains `{"value":` without the rest, so a complete example is unavailable.'],
  ['quoted text presented as source',structuredQuestion,'> The JSON sample is: `{\n\nThis stored example is incomplete; I cannot reconstruct its missing values.'],
  ['short factual quantity','How many items were requested?','9'],
] as const)test(`post-run guard preserves ${label}`,()=>{
  assert.equal(nonAnswerReason(reply(text),question),undefined);
});
