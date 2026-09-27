import test from 'node:test';
import assert from 'node:assert/strict';
import { actionDecision, currentState, evaluatorResponse, finalOutput, qualityScore, taskAnalysis, workflowPlan } from './contracts.js';

const expertDirectives=[
  {name:'Evidence Analyst',directive:'Find primary source evidence for the requested research question.'},
  {name:'Domain Expert',directive:'Explain the core methods and context with evidence.'},
  {name:'Skeptic',directive:'Find limitations and conflicting evidence for the same question.'}
];

test('analysis, decisions, plans and final output accept the public workflow shape', () => {
  assert.equal(taskAnalysis.safeParse({goal:'Find current guidance',constraints:[],requiredInformation:['date'],expectedOutput:'A linked summary'}).success,true);
  assert.equal(actionDecision.safeParse({action:'Search current guidance',reason:'It may have changed',tool:'web_search',expected_output:'Cited findings',subagents:expertDirectives.slice(0,2)}).success,true);
  assert.equal(actionDecision.safeParse({action:'Search current guidance',reason:'It may have changed',tool:'web_search',expected_output:'Cited findings',subagents:expertDirectives}).success,true);
  assert.equal(workflowPlan.safeParse({TASK_ANALYSIS:{goal:'Calculate a total',constraints:[],requiredInformation:[],expectedOutput:'Numeric result'},WORKFLOW_PLAN:[{objective:'Calculate and report the result',suggestedTool:'python',expectedResult:'A verified number'}]}).success,true);
  assert.equal(finalOutput.safeParse({summary:'Completed',completed_actions:['Calculated'],important_results:['2 + 2 = 4'],limitations:[],next_possible_actions:[]}).success,true);
});

test('workflow schemas reject missing fields and unapproved tool names', () => {
  assert.equal(taskAnalysis.safeParse({goal:'Missing fields'}).success,false);
  assert.equal(actionDecision.safeParse({action:'Run shell',reason:'',tool:'shell',expected_output:'',subagents:expertDirectives.slice(0,2)}).success,false);
  assert.equal(actionDecision.safeParse({action:'Search',reason:'',tool:'web_search',expected_output:'',subagents:[expertDirectives[0]]}).success,false);
  assert.equal(actionDecision.safeParse({action:'Search',reason:'',tool:'web_search',expected_output:'',subagents:[...expertDirectives,{name:'Skeptic',directive:'Duplicate role should be rejected structurally.'}]}).success,false);
});

test('workflow plan enforces its step cap', () => {
  const TASK_ANALYSIS={goal:'Plan',constraints:[],requiredInformation:[],expectedOutput:'Steps'};
  const step={objective:'Do work',suggestedTool:'files',expectedResult:'File'};
  assert.equal(workflowPlan.safeParse({TASK_ANALYSIS,WORKFLOW_PLAN:Array.from({length:9},()=>step)}).success,false);
});

test('evaluator evidence, quality score, and current state keep their named schemas', () => {
  const checks={goal_coverage:true,factual_support:true,source_reliability:true,calculation_evidence:false,completeness:true};
  const gaps=['Captured Python output is missing.'];
  assert.equal(evaluatorResponse.safeParse({...checks,gaps}).success,true);
  assert.equal(evaluatorResponse.safeParse({...checks,goal_coverage:'yes',gaps}).success,false);
  assert.equal(qualityScore.safeParse({score:80,checks,gaps,estimate:true}).success,true);
  assert.equal(qualityScore.safeParse({score:105,checks,gaps,estimate:true}).success,false);
  assert.equal(currentState.safeParse({completed_steps:['Research'],remaining_steps:[],knowledge:[{source:'fixture'}],errors:[]}).success,true);
});
