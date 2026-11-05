// 사진 지문(이미지 특징값) 만들기 — 브라우저에서 DINOv2-small 모델로 384개 숫자를 뽑음
// 같은 강아지 사진끼리는 지문이 비슷해서, 쌓일수록 AI 없이도 바로 알아볼 수 있음
// 처음 한 번 모델(약 25MB)을 받고, 그다음부터는 브라우저에 저장된 걸 씀
const MODEL_ID = "onnx-community/dinov2-small";
let ready = null;

export function loadFingerprint(onStatus) {
  if (!ready) {
    ready = (async () => {
      onStatus?.("사진 지문 기능 준비 중… (처음 한 번만 조금 걸려요)");
      const T = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1");
      T.env.allowLocalModels = false;
      const processor = await T.AutoProcessor.from_pretrained(MODEL_ID);
      const model = await T.AutoModel.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm" });
      onStatus?.("");
      return { T, processor, model };
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// blob(이미지) → "[0.0123,...]" (pgvector 형식). 실패하면 null
export async function fingerprint(blob) {
  try {
    const { T, processor, model } = await loadFingerprint();
    const img = await T.RawImage.fromBlob(blob);
    const out = await model(await processor(img));
    let v;
    if (out.pooler_output) v = Array.from(out.pooler_output.data);
    else v = Array.from(out.last_hidden_state.data.slice(0, out.last_hidden_state.dims.at(-1)));
    const n = Math.hypot(...v) || 1;
    return `[${v.map((x) => (x / n).toFixed(5)).join(",")}]`;
  } catch (e) {
    console.warn("fingerprint failed", e);
    return null;
  }
}
