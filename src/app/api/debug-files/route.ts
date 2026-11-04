import fs from "fs";

export const dynamic = "force-dynamic";

export async function GET() {
  const targets = [
    "/var/task/node_modules/@sparticuz/chromium",
    "/var/task/node_modules/playwright-core",
  ];
  const out: Record<string, unknown> = {};
  for (const p of targets) {
    try {
      out[p] = fs.readdirSync(p).slice(0, 30);
      try {
        out[`${p}/bin`] = fs.readdirSync(`${p}/bin`).slice(0, 20);
      } catch (e) {
        out[`${p}/bin`] = `MISSING: ${e}`;
      }
    } catch (e) {
      out[p] = `MISSING: ${e}`;
    }
  }
  return Response.json(out);
}
