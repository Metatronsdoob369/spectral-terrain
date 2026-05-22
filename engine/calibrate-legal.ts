import { writeFileSync } from "fs";

const QDRANT = "http://127.0.0.1:6340";
const COL = "legal-heatmap";

async function fetchAll(): Promise<number[][]> {
  const vectors: number[][] = [];
  let offset: string | null = null;
  while (true) {
    const body: any = { limit: 200, with_vector: true, with_payload: false };
    if (offset) body.offset = offset;
    const res = await fetch(`${QDRANT}/collections/${COL}/points/scroll`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json() as { result: { points: { vector: number[] }[]; next_page_offset: string | null } };
    for (const p of data.result.points) { if (p.vector) vectors.push(p.vector); }
    process.stdout.write(`\r  Fetched ${vectors.length} vectors...`);
    if (!data.result.next_page_offset) break;
    offset = data.result.next_page_offset;
  }
  return vectors;
}

const vecs = await fetchAll();
console.log(`\n  Computing centroid from ${vecs.length} vectors...`);

const dim = vecs[0].length;
const centroid = new Array(dim).fill(0);
for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] += v[i];
for (let i = 0; i < dim; i++) centroid[i] /= vecs.length;

const out = {
  domain: "legal",
  vector: centroid,
  computedAt: new Date().toISOString(),
  corpusSize: vecs.length,
  stability: 0,
  label: `Diamond-Stable-legal-${new Date().toISOString().split("T")[0]}`,
};

writeFileSync(
  "/Users/joewales/NODE_OUT_Master/spectral-terrain/calibration/legal-centroid.json",
  JSON.stringify(out)
);
console.log(`✅ Legal centroid saved — ${vecs.length} vectors, ${dim} dims`);
