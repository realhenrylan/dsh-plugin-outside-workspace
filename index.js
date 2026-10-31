/**
 * Host half of dsh-outside-workspace.
 *
 * The feature is browser-side: it adds a "不在工作区 / Outside workspace"
 * entry to the blank-session hero row, takes over the "未分组" sidebar group's
 * new-session button, and renders a stock-styled start page (project name shown
 * as "不在项目中") for the blank outside-workspace Session it creates. Session
 * creation itself uses the public Client Session Controller
 * (`ctx.sessions.create({ cwd })`), whose Host implementation already accepts a
 * bare `cwd` and creates the directory recursively.
 *
 * No Host service, tool, or event is contributed here; the empty `apply`
 * satisfies the Loader entry contract so the bundle's browser half loads.
 */
export function apply() {}
