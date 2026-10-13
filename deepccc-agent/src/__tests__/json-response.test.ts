import { expect, it } from 'vitest';
import { parseJsonResponse } from '../json-response.js';

it.each([
  ['{"items":[{"value":1,},],}', {items:[{value:1}]}],
  ['{"value":"say \\"x\\" and ,]", \n}', {value:'say "x" and ,]'}],
  ['{"value":"path\\\\",}', {value:'path\\'}],
])('preserves data while repairing: %s', (text, value)=>{
  expect(parseJsonResponse(text as string)).toEqual({value,repaired:true});
});
it.each(['{"items":[,]}','{"items":[1,,]}','{"value":}','{"items":[1,','{"value":1,,}'])('rejects missing values: %s',text=>{
  expect(()=>parseJsonResponse(text)).toThrow();
});
it('leaves valid text untouched',()=>{
  expect(parseJsonResponse('{"value":",}"}')).toEqual({value:{value:',}'},repaired:false});
});
