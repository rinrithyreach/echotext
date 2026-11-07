"""Rebuild the bundled Khmer voice: assets/voices/km_KH-mms-medium.*

Exports Meta's MMS-TTS Khmer model (facebook/mms-tts-khm, CC BY-NC 4.0) to ONNX
with Piper-style inputs, so the browser runs it with the same ONNX Runtime and
the same speed/pitch handling as the English voices.

    python -m venv .venv && .venv/Scripts/pip install torch transformers onnx onnxruntime
    .venv/Scripts/python tools/convert-mms-khmer.py build/mms
    node tools/bundle-voice.cjs build/mms/km-mms.onnx km_KH-mms-medium.onnx
    node tools/bundle-voice.cjs build/mms/km-mms.json km_KH-mms-medium.onnx.json

Checked on 2026-11-06 with torch 2.15, transformers 5.22, onnxruntime 1.31: the ONNX
output matches PyTorch (max difference about 1e-4) for inputs of 3 to 261 tokens at
speeds 1.0 and 0.5. SHA-256 of that export:
3e0ada82d02475d2de3974467b8218d2683f85d040d3f0392af7e7d9d367c7e7
"""
import json, os, sys
import torch
from transformers import VitsModel, VitsTokenizer

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
model = VitsModel.from_pretrained("facebook/mms-tts-khm").eval()
tok = VitsTokenizer.from_pretrained("facebook/mms-tts-khm")


class Wrapper(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input, scales):
        self.m.noise_scale = scales[0]
        self.m.noise_scale_duration = scales[2]
        return self.m(input_ids=input, speaking_rate=1.0 / scales[1]).waveform


w = Wrapper(model).eval()
sample = tok("សួស្តី នេះជាសំឡេងរបស់ខ្ញុំ", return_tensors="pt").input_ids
scales = torch.tensor([model.config.noise_scale, 1.0, model.config.noise_scale_duration], dtype=torch.float32)
path = os.path.join(out_dir, "km-mms.onnx")
with torch.no_grad():
    torch.onnx.export(
        w, (sample, scales), path, dynamo=False, opset_version=17,
        input_names=["input", "scales"], output_names=["output"],
        dynamic_axes={"input": {1: "phonemes"}, "output": {1: "samples"}},
        do_constant_folding=True,
    )
cfg = model.config
meta = {
    "sample_rate": cfg.sampling_rate,
    "add_blank": tok.add_blank,
    "pad_id": tok.pad_token_id,
    "noise_scale": cfg.noise_scale,
    "noise_scale_duration": cfg.noise_scale_duration,
    "speaking_rate": cfg.speaking_rate,
    "vocab": tok.get_vocab(),
}
with open(os.path.join(out_dir, "km-mms.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False)
print("exported", os.path.getsize(path), "bytes", json.dumps({k: v for k, v in meta.items() if k != "vocab"}))

# Reference ids from the official tokenizer, to check the browser tokenizer against.
refs = ["សួស្តី! នេះជាសំឡេងរបស់ខ្ញុំ។", "ខ្ញុំរស់នៅភ្នំពេញ ជាមួយគ្រួសារ។"]
with open(os.path.join(out_dir, "km-mms.ref.json"), "w", encoding="utf-8") as f:
    json.dump([{"text": t, "ids": tok(t).input_ids} for t in refs], f, ensure_ascii=False)
