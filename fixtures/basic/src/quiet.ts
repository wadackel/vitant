/** Whether deprecation warnings are kept quiet, as `--no-deprecation` has them. */
export function quiet(): boolean {
  return process.noDeprecation === true
}
