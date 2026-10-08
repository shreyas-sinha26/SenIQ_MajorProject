#!/usr/bin/env python3
"""
Fine-tune FinBERT to read a headline FOR ONE COMPANY ("targeted sentiment").

    .venv/bin/python training/train_target_sentiment.py            train, evaluate, export
    .venv/bin/python training/train_target_sentiment.py --epochs 4

FinBERT gives one reading for a whole text. SEntFiN (Sinha et al., MIT licence) is about
10,700 Indian financial headlines in which every named entity carries its own label, and
2,800 of them name several entities — often with opposite labels. Training on
"<entity> | <headline>" → that entity's label teaches the model to answer for the company
it is asked about.

The input is one plain string with a " | " between the company and the text: no second
segment and no special tokens, so the JavaScript runtime builds exactly the same input.

Data: training/data/SEntFiN.csv from https://github.com/pyRis/SEntFiN (not committed).
Base: ProsusAI/finbert, fetched by the library; if that stalls, download config.json,
vocab.txt, tokenizer_config.json, special_tokens_map.json and pytorch_model.bin from its
Hugging Face page into a folder and pass --base <folder>.
Output: models/target-finbert/ — the PyTorch model, and onnx/model_quantized.onnx for
@huggingface/transformers (FINBERT_TARGET_MODEL points at the folder). Not committed.

One tenth of the headlines is held out, by headline, so no headline is in both halves; the
script prints accuracy on it, and FinBERT's own accuracy on the same pairs before training.
"""
import argparse
import ast
import csv
import json
import os
import random
import time

import torch
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASE = "ProsusAI/finbert"
SEP = " | "


def load_pairs(path):
    """SEntFiN rows → [(headline_id, entity, headline, label)]."""
    out = []
    with open(path, newline="", encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f)):
            title = (row.get("Title") or "").strip()
            raw = row.get("Decisions") or ""
            try:
                decisions = json.loads(raw)
            except ValueError:
                try:
                    decisions = ast.literal_eval(raw)
                except (ValueError, SyntaxError):
                    continue
            for entity, label in decisions.items():
                label = str(label).strip().lower()
                if title and entity and label in ("positive", "neutral", "negative"):
                    out.append((i, str(entity).strip(), title, label))
    return out


def batches(tok, rows, label2id, size, shuffle, max_len):
    def collate(items):
        enc = tok([f"{e}{SEP}{t}" for _, e, t, _ in items], padding=True, truncation=True, max_length=max_len, return_tensors="pt")
        enc["labels"] = torch.tensor([label2id[l] for *_, l in items])
        return enc
    return DataLoader(rows, batch_size=size, shuffle=shuffle, collate_fn=collate)


@torch.no_grad()
def accuracy(model, loader, device):
    model.eval()
    ok = n = 0
    for b in loader:
        b = {k: v.to(device) for k, v in b.items()}
        pred = model(**{k: v for k, v in b.items() if k != "labels"}).logits.argmax(-1)
        ok += (pred == b["labels"]).sum().item()
        n += len(pred)
    return ok / max(n, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data", "SEntFiN.csv"))
    ap.add_argument("--out", default=os.path.join(ROOT, "models", "target-finbert"))
    ap.add_argument("--base", default=BASE, help="the model to start from: a Hugging Face id or a local folder")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-len", type=int, default=96)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"

    pairs = load_pairs(args.data)
    ids = sorted({p[0] for p in pairs})
    random.shuffle(ids)
    held = set(ids[: len(ids) // 10])
    train = [p for p in pairs if p[0] not in held]
    val = [p for p in pairs if p[0] in held]
    multi = {i for i in held if sum(1 for p in val if p[0] == i) > 1}
    val_multi = [p for p in val if p[0] in multi]
    print(f"{len(pairs)} (entity, headline) pairs from {len(ids)} headlines; train {len(train)}, held out {len(val)} "
          f"({len(val_multi)} of them in multi-entity headlines); device {device}")

    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForSequenceClassification.from_pretrained(args.base).to(device)
    label2id = {k.lower(): v for k, v in model.config.label2id.items()}  # FinBERT's own order, so its head is reused

    val_loader = batches(tok, val, label2id, 64, False, args.max_len)
    multi_loader = batches(tok, val_multi, label2id, 64, False, args.max_len)
    # FinBERT as it is, on the bare headline: the reading every entity in it gets today.
    bare = batches(tok, [(i, "", t, l) for i, _, t, l in val], label2id, 64, False, args.max_len)
    bare_multi = batches(tok, [(i, "", t, l) for i, _, t, l in val_multi], label2id, 64, False, args.max_len)
    print(f"before training — FinBERT on the headline alone: {accuracy(model, bare, device):.3f} "
          f"(multi-entity headlines: {accuracy(model, bare_multi, device):.3f})")

    loader = batches(tok, train, label2id, args.batch, True, args.max_len)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = len(loader) * args.epochs
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for step, b in enumerate(loader):
            b = {k: v.to(device) for k, v in b.items()}
            loss = model(**b).loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            total += loss.item()
            if step % 100 == 99:
                print(f"  epoch {epoch + 1} step {step + 1}/{len(loader)} loss {total / (step + 1):.4f} ({time.time() - t0:.0f}s)", flush=True)
        print(f"epoch {epoch + 1}: loss {total / len(loader):.4f}, held-out accuracy {accuracy(model, val_loader, device):.3f} "
              f"(multi-entity: {accuracy(model, multi_loader, device):.3f})", flush=True)

    os.makedirs(args.out, exist_ok=True)
    model.to("cpu").save_pretrained(args.out)
    tok.save_pretrained(args.out)
    print(f"saved to {args.out}")

    # ONNX for the JavaScript runtime, then 8-bit weights (what FINBERT.LOCAL_DTYPE 'q8' loads).
    from optimum.onnxruntime import ORTModelForSequenceClassification, ORTQuantizer
    from optimum.onnxruntime.configuration import AutoQuantizationConfig
    onnx_dir = os.path.join(args.out, "onnx")
    ORTModelForSequenceClassification.from_pretrained(args.out, export=True).save_pretrained(onnx_dir)
    ORTQuantizer.from_pretrained(onnx_dir).quantize(save_dir=onnx_dir, quantization_config=AutoQuantizationConfig.arm64(is_static=False, per_channel=False))
    print("exported:", sorted(f for f in os.listdir(onnx_dir) if f.endswith(".onnx")))


if __name__ == "__main__":
    main()
