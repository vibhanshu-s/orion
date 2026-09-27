import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from '@langchain/langgraph';

export type WorkflowContext = Record<string, any> & {
  taskId: string;
  goal: string;
  graphRunId: string;
  TASK_ANALYSIS?: any;
  WORKFLOW_PLAN?: any[];
  clarification?: string;
  clarificationAnswer?: string;
  stepIndex?: number;
  score?: number;
  gaps?: string[];
  improvement_passes?: number;
};

export type WorkflowHandlers = {
  analyze(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  requestClarification(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  resolveClarification(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  retrieveMemory(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  plan(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  decide(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  execute(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  observe(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  evaluate(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  improve(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
  finalize(context: WorkflowContext): Promise<Partial<WorkflowContext>>;
};

const GraphState = Annotation.Root({ context: Annotation<WorkflowContext>() });
type State = typeof GraphState.State;
type HandlerName = keyof WorkflowHandlers;

export function createWorkflowGraph(handlers: WorkflowHandlers, checkpointer = new MemorySaver()) {
  const node = (name: HandlerName) => async ({ context }: State) => ({
    context: { ...context, ...(await handlers[name](context)) },
  });
  const graph = new StateGraph(GraphState)
    .addNode('analyze', node('analyze'))
    .addNode('request_clarification', node('requestClarification'))
    .addNode('await_clarification', async ({ context }: State) => {
      const answer = interrupt({ question: context.clarification });
      return { context: { ...context, clarificationAnswer: String(answer) } };
    })
    .addNode('resolve_clarification', node('resolveClarification'))
    .addNode('retrieve_memory', node('retrieveMemory'))
    .addNode('plan', node('plan'))
    .addNode('decide', node('decide'))
    .addNode('execute', node('execute'))
    .addNode('observe', node('observe'))
    .addNode('evaluate', node('evaluate'))
    .addNode('improve', node('improve'))
    .addNode('finalize', node('finalize'))
    .addEdge(START, 'analyze')
    .addConditionalEdges('analyze', ({ context }: State) => {
      if (context.clarification && !context.clarificationAnswer) return 'request_clarification';
      if (context.clarification && context.clarificationAnswer) return 'resolve_clarification';
      return 'retrieve_memory';
    }, {
      request_clarification: 'request_clarification',
      resolve_clarification: 'resolve_clarification',
      retrieve_memory: 'retrieve_memory',
    })
    .addEdge('request_clarification', 'await_clarification')
    .addEdge('await_clarification', 'resolve_clarification')
    .addEdge('resolve_clarification', 'retrieve_memory')
    .addEdge('retrieve_memory', 'plan')
    .addEdge('plan', 'decide')
    .addEdge('decide', 'execute')
    .addEdge('execute', 'observe')
    .addConditionalEdges('observe', ({ context }: State) => (context.stepIndex ?? 0) < (context.WORKFLOW_PLAN?.length ?? 0) ? 'decide' : 'evaluate', {
      decide: 'decide',
      evaluate: 'evaluate',
    })
    .addConditionalEdges('evaluate', ({ context }: State) => {
      const canImprove = (context.score ?? 0) < 85
        && (context.improvement_passes ?? 0) < 2
        && Boolean(context.gaps?.length);
      return canImprove ? 'improve' : 'finalize';
    }, { improve: 'improve', finalize: 'finalize' })
    .addEdge('improve', 'evaluate')
    .addEdge('finalize', END);

  return graph.compile({ checkpointer });
}

export { MemorySaver };
