# Builder Hub: Mecklenburg distress data refresh

Refreshes `targets_meck.json` in the DLG Builder Hub artifact (https://claude.ai/artifact/98ojjCMBC1fEkzfV1TDQYW) with
fresh City of Charlotte code-enforcement cases and the Mecklenburg delinquent-tax list.

1. In Damien's Chrome, open the code-cases page named at the top of `code_cases.js`, run the file's contents with the
   JavaScript tool, poll `window.CEst` until `done`. It downloads `dlg_charlotte_code_cases.json` to ~/Downloads.
2. Open the tax page named at the top of `tax_list.js`, run it, poll `window.TXst` until `done`. Downloads `dlg_meck_tax.json`.
3. Read the current `targets_meck.json` from the artifact (Artifact read, path targets_meck.json), stage both downloads, then:
   `python3 merge_meck.py targets_meck.json --code dlg_charlotte_code_cases.json --tax dlg_meck_tax.json -o targets_meck.new.json`
4. Republish the artifact keeping its page: read the artifact's index.html (Artifact read), publish it to the same url with
   `files: {"targets_meck.json": "targets_meck.new.json"}`.
5. Delete the two downloads from ~/Downloads only if allowed; otherwise leave them. Close every Chrome tab you opened.

Code cases cover Charlotte city limits only (towns run their own code enforcement). The tax list is the county's
published delinquent list; it updates a few times a year.
