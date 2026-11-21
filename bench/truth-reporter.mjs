// Vitest ends with an error for what nothing handled, in a run whose tests
// all pass, and its JSON report does not say so. This writes their messages,
// under whichever of the two names the running Vitest calls.
import fs from 'node:fs'

const write = (errors) =>
  fs.writeFileSync(process.env.VITANT_TRUTH_ERRORS, JSON.stringify((errors ?? []).map((error) => String(error?.message ?? error))))

export default class {
  onFinished(_files, errors) {
    write(errors)
  }
  onTestRunEnd(_modules, errors) {
    write(errors)
  }
}
