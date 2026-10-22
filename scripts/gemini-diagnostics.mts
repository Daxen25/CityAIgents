/** Explicit operator entrypoint; importing the testable library performs no work. */
import { runGeminiDiagnostic } from "./lib/gemini-diagnostics";
runGeminiDiagnostic(process.argv.slice(2), process.env).then(({ exitCode, result }) => {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = exitCode;
}).catch(() => {
  process.stdout.write('{"operation":"local","outcome":"failed","failureClass":"diagnostic_unavailable"}\n');
  process.exitCode = 1;
});
