import { pathToFileURL } from "node:url";
import { inside, VERSION } from "./project.mjs";

// Extensions run in the trusted authoring controller, never inside QuickJS.
export async function extension(p, kind, name) {
  const spec = p.extensions?.find((e) => e.kind === kind && e.name === name);
  if (!spec)
    throw Error(
      `Unknown ${kind} provider ${name}; declare an extension module`,
    );
  const provider = (await import(pathToFileURL(inside(p.root, spec.file)).href))
    .default;
  if (provider?.apiVersion !== VERSION)
    throw Error(`Incompatible ${kind} provider ${name}`);
  return provider;
}
