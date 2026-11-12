// Only observes module resolution; never substitutes an SDK or changes a request.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'claude-agent-sdk-next') console.log('TCB_TEST_NEXT_SDK_IMPORT');
  return nextResolve(specifier, context);
}
