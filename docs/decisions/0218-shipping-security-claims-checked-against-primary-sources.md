# ADR 0218: 出荷文書の「セキュリティの主張」に一次情報を当てた — CVE 番号は実在した（引く先が違っただけ）。ただし推奨下限は「既知の CVE が残らない下限」ではない

- **状態**: 採用 (2026-09-17)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（ADR 0126 / 0127 / 0128 / 0132 / 0217 の体裁を踏む）。

- **【実測】** — この作業でコマンドを打って得た。
- **【現物】** — この repo のファイルを読んで確かめた。
- **【受】** — 報告として受け取り、この作業では再導出していない。

## 文脈

[ADR 0217](./0217-provenance-naming-lost-in-duplication-swept-from-the-population.md) は
`docs/` 220本を掃いて、**`CVE-2026-3172` が3箇所に複製され、どこにも一次情報が無かった**ことを記録した。
そのうえで上流を当て直し、**「バッファオーバーフロー修正が `0.8.2` に在る」ことは裏を取りつつ、
`CVE-2026-3172` という番号だけは「未確認」として残した。**

🔴 **これは v1.0.0 と一緒に出る文書に載る、「利用者に依存バージョンの下限を指示する」主張である。**
**番号が誤っていれば、利用者は誤った CVE を調べることになる。**

⭐ **ADR 0217 は、当てられなかった先を正直に書いていた**——
「GitHub advisory database で引けなかっただけで、**CVE データベースを直接当てていない**」。
⟹ **本 ADR はそこを埋めた。**

## 測ったこと1 — `CVE-2026-3172` は実在し、内容も文書の記述と一致する

**【実測 2026-09-17】当てた先と、返ってきたもの:**

| 当てた先 | 返ってきたもの |
|---|---|
| MITRE CVE Services `https://cveawg.mitre.org/api/cve/CVE-2026-3172` | **HTTP 200 / `state: PUBLISHED`**。採番者は **PostgreSQL**。`datePublished` `2026-02-25T20:59:10Z` |
| NVD `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-3172` | **HTTP 200 / `totalResults: 1`**。`vulnStatus: Deferred`、CVSS v3.1 **8.1 HIGH**、CWE-191 / CWE-787 |
| GitHub advisory database `gh api "/advisories?cve_id=CVE-2026-3172"` | **該当1件** — [`GHSA-789c-mgqf-5hwx`](https://github.com/advisories/GHSA-789c-mgqf-5hwx) |
| 上流 issue | [pgvector#959](https://github.com/pgvector/pgvector/issues/959)（closed） |

- MITRE の `title` は **"pgvector buffer overflow in parallel HNSW index build"**、
  `affected` は **`0.6.0` 以上 `0.8.2` 未満**（`lessThan: "0.8.2"`）。
- ⟹ ⭐ **「0.8.2 が `CVE-2026-3172` を直した」も「だから `>= 0.8.2`」も、この CVE に関する限り正しい。**

## 測ったこと2 — 🔴 **「引けなかった」の原因は、番号ではなく引き方だった**

**【実測】** `GHSA-789c-mgqf-5hwx` は **`type: unreviewed` かつ `vulnerabilities: []`** である
（＝ ecosystem / package への対応付けを持たない）。

⟹ ⛔ **`affects=` や `ecosystem=` で絞る引き方では、この advisory には届かない。**
⭐ **`cve_id=` で引けば1件返る。**

🔴 **⟹ 「1つのデータベースで引けなかった」は「無い」の根拠にならない。**
⭐ **ADR 0217 が「存在しないとは言えない、未確認である」と書いて止めた線は、正しかった。**
**同じ状況で「存在しない」と書いていたら、この ADR は「誤りを訂正する ADR」になっていた。**

## 測ったこと3 — ⚠ **推奨下限 `>= 0.8.2` は「既知の CVE が1つも残らない下限」ではない**

**【実測 2026-09-17、上流 `CHANGELOG.md` と NVD `keywordSearch=pgvector`（`totalResults: 6`、うち pgvector 本体は2件）】**

| 版 | 直したもの | セキュリティ採番 |
|---|---|---|
| `0.8.2` (2026-02-25) | buffer overflow with parallel HNSW index build（[#959](https://github.com/pgvector/pgvector/issues/959)） | **`CVE-2026-3172`** CVSS 8.1 HIGH。**システムを問わない** |
| `0.8.3` (2026-06-17) | possible index corruption with HNSW vacuuming ほか | **無し** |
| `0.8.4` (2026-06-30) | `hnsw graph not repaired` ほか | **無し** |
| `0.8.5` (2026-07-08) | IVFFlat 構築のメモリ使用量 | **無し** |
| `0.8.6` (2026-07-29) | buffer overflow with IVFFlat index build on 32-bit systems（[#1006](https://github.com/pgvector/pgvector/issues/1006)） | **`CVE-2026-18022`** CVSS 8.8 HIGH。⚠ **32bit システムのみ** |

- 🔴 **`CVE-2026-18022` の MITRE `affected` は `lessThan: "0.8.6"` / `version: "0"`** ＝ **`0.8.6` 未満のすべて**。
- ⭐ **ただし逐語で *"Only 32-bit systems are affected."*** ⟹ **64bit だけを対象に置くなら、
  `>= 0.8.2` のままでも既知の CVE は残らない。**
- ⚠ **ADR 0217 が「下限が古い」の根拠に挙げた `0.8.3` の index corruption は、採番されていない**
  ——⟹ **それは正しさの根拠であって、セキュリティの根拠ではない。** 🔴 **2つを混ぜないこと。**

## 測ったこと4 — ⭐ **同じ形が、もう1つの出荷文書にも在った**

**【現物】** `packages/local-embedding/README.md`（**npm に出ている README** である）と
[ADR 0096](./0096-bootstrap-local-embedding-onto-npm.md)「測ったこと10」が、
**libvips の4つの CVE と libheif の2つの GHSA を、出典なしで並べていた。**

**【実測 2026-09-17】6つとも一次情報へ辿れた:**

- **libvips の4件**（`CVE-2026-33327` / `-33328` / `-35590` / `-35591`）は MITRE で **4件とも `PUBLISHED`**。
  sharp 側の名乗りは [`GHSA-f88m-g3jw-g9cj`](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)（`sharp < 0.35.0`）で、
  **4つの番号が summary に逐語で並んでいる。**
- **libheif の2件**は ⚠ **当てた3箇所すべてで 404**（`gh api /advisories/<id>` / `github.com/advisories/<id>` /
  `api.osv.dev/v1/vulns/<id>`）。⛔ **「存在しない」ではない**——**`strukturag/libheif` のリポジトリ配下の
  advisory** であり、グローバルの advisory database と OSV には載っていない。
  [`GHSA-rgj7-g3m4-5g8c`](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) の `references` がその URL を指す。
  **`GHSA-g89c-p67h-r497` には `CVE-2026-84383` も付いている。**
- ⟹ ⭐ **識別子は正しい。ここでも「引く先が違う」だけだった**（測ったこと2 と同じ形である）。

⚠ **1点だけ、言い回しが実測より強かった。** 本文は **「`fixAvailable: false`——上流に修正版が無いので」**と書くが、
**`npm audit` の `fixAvailable: false` は「いまの依存木の制約の中では上げられない」であって
「上流に修正版が無い」ではない。** **【実測】**上流 `sharp` には修正版が在る（`0.35.0` / `0.35.4`）。
**【現物】**この repo の `pnpm-lock.yaml` が解決しているのは **`sharp@0.34.5`**
（`@huggingface/transformers@4.2.0` 経由）である。⟹ **上げられないのは上流ではなく、依存木の制約の側である。**

## 決定

### 1. **元の記述は消さず、一次情報への参照を追記で足す**

ADR 0217 決定1 と同じ形を踏む。⛔ **本文も、ADR 0217 が足した追記1 も書き換えていない。**
**「追記2」として、当てた先を全部並べた表を足した。**

⭐ **`docs/roadmap.md` §4 だけは、表のセルが「番号自体も裏が取れていない」と
いま誤ったことを言っているので、そこは訂正した**——⛔ **消さずに「2026-09-17 訂正」と明記し、
何がどう変わったかを残す形にした。**

### 2. **正規の置き場は `docs/memory-model.md` のままにする**

ADR 0217 決定2 を引き継ぐ。逐語・当てた先の一覧・判断材料は
`docs/memory-model.md`「前提: pgvector のバージョン」に置き、ADR 0002 と `docs/roadmap.md` §4 はそこを指す。

### 3. ⛔ **下限の数字は、この ADR でも書き換えない**

ADR 0217 決定3 を引き継ぐ。**`>= 0.8.2` を `>= 0.8.6` へ動かさない。**
⭐ **代わりに「`0.8.2` で残る CVE は何か」「それは誰に効くか（32bit のみ）」を並べた。**
🔴 **下限を動かすかは製品判断である**——**mnemora が 32bit を対象に含めるかを、この ADR は決めない。**

### 4. ⭐ **「1つのデータベースで引けなかった」を「無い」と書かない、を規律として残す**

**測ったこと2 が実例である。** ⟹ **セキュリティ識別子を当てるときは、
最低限 MITRE・NVD・GitHub advisory database（`cve_id=` で）・上流の CHANGELOG/issue の4箇所を当て、
⭐ 当てた先を全部書くこと。** ⛔ **引けなかったときは「当てた先（列挙）では引けなかった」と書くこと。**

## これが覆るとしたら

- **NVD / MITRE の記載が後から変わったら**（`CVE-2026-3172` の `vulnStatus` は現在 `Deferred` である）。
  ⟹ 上の表は **2026-09-17 時点の写し**であり、`cveId=` / `keywordSearch=pgvector` で引き直せる。
- **pgvector に新しい CVE が出たら**、測ったこと3 の表は下限の判断材料として古くなる。

## 確かめていないこと

- ⛔ **マネージド Postgres 各社が実際に提供する pgvector のバージョンは、今回も確認していない**
  （ADR 0002 / `docs/memory-model.md` が既に「確かめていないこと」として持っている）。
- ⛔ **`CVE-2026-18022` が 32bit のみに効くことを、自分で再現してはいない。**
  MITRE の記述（*"Only 32-bit systems are affected."*）と上流 `CHANGELOG.md` の
  *"on 32-bit systems"* の**字面の一致**を根拠にしている。
- ⛔ **`packages/local-embedding/README.md` の `npm audit` の実行そのものは再現していない。**
  ⟹ **`high: 5` / `critical: 0` という件数は、この作業では裏を取っていない。**
  当てたのは**この repo の `pnpm-lock.yaml`** であって、公開物を素の consumer が install した木ではない。
- ⛔ **`GHSA-g89c-p67h-r497` / `GHSA-2jg2-4ch7-h545` の中身は読んでいない。**
  リポジトリ配下の advisory の URL が `GHSA-rgj7-g3m4-5g8c` の `references` に在ることは確かめたが、
  **その URL を開いてはいない。**
- ⛔ **`docs/` と `packages/` に他にもセキュリティ識別子が在るかは、`grep -rn "CVE"` と
  `grep -rn "GHSA"` の字面で探した範囲である。** ⚠ **番号を書かずに脆弱性へ言及している記述は、この掃きをすり抜ける。**
