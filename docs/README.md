# docs — 設計判断の記録

**ここに在るのは設計判断とその理由である。**実装そのものは `packages/` と `examples/` に在り、
**Phase 1（MVP）は一巡している**（`docs/roadmap.md` §2 の段階1〜7）。
**この文書群は実装の説明書ではなく、なぜそう決めたかの記録である。**

## 読む順

| 文書 | 何が書いてあるか |
|---|---|
| [north-star.md](./north-star.md) | **正典。**目的 / 目指す姿 / 物差し / 迷ったときの問い / やらないこと |
| [vision.md](./vision.md) | このプロジェクトの理解 / 用語整理 / やらないこと / 名前 |
| [architecture.md](./architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [memory-model.md](./memory-model.md) | DB schema 案 / Memory lifecycle / provenance / 矛盾 / 忘却 / 監査ログ |
| [recall.md](./recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [roadmap.md](./roadmap.md) | Phase 1 実装計画 / 技術上のリスク / **まだ判断が必要な点** |
| [alteroid-findings.md](./alteroid-findings.md) | 設計の材料にした運用知見を現物で検証した記録 |
| [decisions/](./decisions/) | ADR（重大な設計判断とその理由） |

## 目指しているもの

**LLM アプリケーションに「思い出す」を与えること。「保存する」ではなく。**
物差しは一つ——**使う側が、会話ログを全部プロンプトへ積むのをやめられたか。**
詳細は [north-star.md](./north-star.md)（正典）。

## 全体を貫く一本の原則

> **文脈を剥がして提示しない (Qualified Presentation)**

1. **争われている主張は、それを争う相手と必ず同時に提示する**（矛盾の扱い）
2. **推論は、その根拠と必ず同時に提示する**（provenance）
3. **結果は、そこから漏れたものと必ず同時に提示する**（説明可能性 / 不在の分類）

三つは別々の機能ではなく、同じ一つの規律の適用先が違うだけである。
詳細は [vision.md](./vision.md) を見ること。

## 外から見える API

**記憶そのものを動かす中核**は `observe()` / `recall()` / `reflect()` / `consolidate()` /
`forget()` の5つ。**ここは増やさない。**`Runtime` には他に9個のメソッドがあるが、
保守操作・是正取り消し・説明の3層に分かれる（[docs/vision.md](./vision.md)「外から見える
API」、[ADR 0171](./decisions/0171-five-verbs-plus-three-layers.md)）。

## オーナーの判断を待っている点

[roadmap.md](./roadmap.md) の「設計上まだ判断が必要な点」を見ること。6項目が挙がっており、
そのうち 5.1（名前）と 5.2（抽出の既定）は解決済みとして追記で閉じてある。
それ以外は**設計側で決めて、理由を ADR に残してある。**
