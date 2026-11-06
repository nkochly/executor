/** The bundled isolate each `execute` program runs in, written by `scripts/generate.ts`. */
declare module "executor:program-sandbox" {
  const code: string;
  export default code;
}
