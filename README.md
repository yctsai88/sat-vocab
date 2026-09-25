# SAT 單字

可以離線使用的 SAT 單字學習程式（PWA）。

## 目錄結構

- `sat_hot_words_pages_1_36.csv`：原始單字清單
- `data/words.txt`：修正後的單字清單（5,002 字）
- `data/gen/*.json`：產生好的單字內容（音標、解釋、例句、字根……），分批存放
- `scripts/build.py`：檢查資料格式，合併成 `docs/words.json`，並更新離線快取版本
- `docs/`：網站本體，GitHub Pages 會發布這個資料夾

## 本機執行

```bash
python3 scripts/build.py
python3 -m http.server 8765 --directory docs
```

然後用瀏覽器打開 http://localhost:8765 。

## 發布到 GitHub Pages

1. 把整個專案推到 GitHub repo。
2. 到 repo 的 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`，資料夾選 `/docs`。
3. 用手機打開產生的網址：
   - iPhone（Safari）：分享 →「加入主畫面」
   - Android（Chrome）：選單 →「安裝應用程式」
4. 第一次打開後就會存到手機裡，之後不用連網也能用。

每次改完資料或程式，都要先執行 `python3 scripts/build.py` 再推上去。手機下次連網打開時會在背景更新，再打開一次就會是新版。

## 單字資料格式

```json
{
  "w": "benevolent",
  "kk": "[bəˋnɛvələnt]",
  "tier": 1,
  "senses": [{"pos": "adj.", "en": "well-meaning and kindly", "zh": "仁慈的"}],
  "ex": [{"en": "A benevolent stranger paid for the family's groceries.", "zh": "……"}],
  "root": {"parts": [{"p": "bene-", "m": "good 好"}, {"p": "vol", "m": "wish 意願"}], "note": "懷著好的意願 → 仁慈的"},
  "syn": ["kind"], "ant": ["malevolent"],
  "mn": "記憶口訣（選填）"
}
```

- `tier`：1 核心、2 進階、3 冷僻
- `ex` 的第一句必須包含這個字原本的拼法，因為例句填空題要用
- 字首寫成 `bene-`，字尾寫成 `-ent`，字根不加連字號；字根拆解裡寫法相同的部分會自動串成「同字根的字」
