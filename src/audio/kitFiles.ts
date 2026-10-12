import type { KitJson } from './kit';

/** Decoded samples per instrument: buffers[instrumentId][layer][variant]. */
export type KitBuffers = Record<string, AudioBuffer[][]>;

function kitBase(id: string): string {
  return `${import.meta.env.BASE_URL}kits/${id}/`;
}

export async function fetchKitJson(id: string): Promise<KitJson> {
  const res = await fetch(`${kitBase(id)}kit.json`);
  if (!res.ok) throw new Error(`Kit ${id}: ${res.status}`);
  return (await res.json()) as KitJson;
}

/** Fetches and decodes every sample of a kit (resampled to `ctx`'s rate). */
export async function decodeKitBuffers(ctx: BaseAudioContext, id: string, json: KitJson): Promise<KitBuffers> {
  const base = kitBase(id);
  const decode = async (file: string) => {
    const r = await fetch(base + file);
    if (!r.ok) throw new Error(`Kit ${id}/${file}: ${r.status}`);
    return ctx.decodeAudioData(await r.arrayBuffer());
  };
  const buffers: KitBuffers = {};
  await Promise.all(
    Object.entries(json.instruments).map(async ([inst, def]) => {
      buffers[inst] = await Promise.all(def.layers.map((l) => Promise.all(l.samples.map(decode))));
    }),
  );
  return buffers;
}
