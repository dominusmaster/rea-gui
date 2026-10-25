// Copies the static files (HTML, CSS, icons) next to the compiled browser scripts in dist/public.
import { cpSync } from "node:fs";

cpSync(new URL("../public", import.meta.url), new URL("../dist/public", import.meta.url), { recursive: true });
