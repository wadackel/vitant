// Made once as the module loads, so with a mutant only where the mutant was
// on from before the file was imported: in a run of a whole file, never
// while a test tries it in a worker. No test leads to its mutants, and what
// their runs of whole files fail in is all there is to go by.
export const drift = () => true
export const drifted = drift()
