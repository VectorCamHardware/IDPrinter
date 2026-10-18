# IDPrinter

Generates printable specimen ID sheets for VectorCam. Each sheet has rows of ID labels (for example `AIA001`–`AIA080`), a 15 mm reference, and the name / program of the person who printed it.

## Prefix modes

| Mode | Prefix | Numbers | Repeats |
| --- | --- | --- | --- |
| **Auto** | Assigned by the print log: the first three-letter prefix, in alphabetical order (`AAA`, `AAB`, …, `ZZZ`), that does not appear in the log. | `001` to the end number (at most `992`). | No. Each auto prefix is used by one print only. |
| **Test** | `TST` | Any range (8n+1 to 8n+8). | Yes. A repeated range is logged with `reprint` `TRUE`. |

Prefixes used by the synced perforated sheets (see below) are in the log, so auto mode never assigns them. `RESERVED_PREFIXES` in `apps-script/Code.gs` lists further prefixes that auto mode skips: `TST`, and `AEM` and `AEN` (the archived file `VCI_Perforated_AEM_AEN.docx` holds ADM/ADN codes, so it is not known whether AEM or AEN labels were printed).

The preview shows the prefix the next auto print will receive. The prefix is assigned when the Print button is pressed; if another print took that prefix in the meantime, the sheet is printed with the next free prefix.

## Print log

Every printed sheet is recorded. Auto ranges cannot be printed again.

```
index.html ──reserve──▶ Apps Script web app ──▶ Google Sheet ("Log" tab)
                                                       │
                     GitHub Action, every 6 hours ◀────┘
                                │
                                ▼
                     data/printed_sheets.csv (validated, committed)
```

- **Google Sheet:** the live log and the source of truth. `apps-script/Code.gs` runs as a web app bound to it.
- **Print button:** sends the range to the web app before printing. In auto mode the web app assigns the prefix; in test mode it records the TST range. Printing with Ctrl+P, without the button, prints only a notice.
- **`data/printed_sheets.csv`:** a copy of the log in the repository, updated by `.github/workflows/sync-printed-sheets.yml` every 6 hours, or on demand from the Actions tab. `scripts/validate_print_log.py` checks the export before it is committed.
- **Print ID:** each logged print receives an ID (for example `P-3F9A1C2B`), which is printed in the bottom margin of each page next to the name and program.

### Updating the web app

After `apps-script/Code.gs` changes, paste it into the Apps Script editor and deploy a new version (**Deploy → Manage deployments → Edit → Version: New version**). The web app URL does not change. On the first request after the update, the Log tab receives the `source` and `note` columns, and existing rows are marked `print`.

## Synced sheets (printed before the ID Printer)

Specimen ID sheets printed from Word documents before the ID Printer existed are recorded in the log with `source` `sync`, so their prefixes are known and are not assigned again.

- **`data/legacy/Perforated_Sheet.zip`:** the original Google Drive folder of documents (`VCI_Perforated_<P1>_<P2>.docx`), unchanged. Each folder is named `<group> (<description>)`, for example `AA (Printed, Mayuge Stationary)`.
- **`data/synced_sheets.csv`:** one row per prefix per document, in the log format, built from the archive by `scripts/build_synced_sheets.py`. The `Template` folder is not included.
- **Import:** in the Google Sheet, **ID Printer → Import synced sheets from repository** appends the rows of `data/synced_sheets.csv` that are not yet in the Log tab (matched by print ID). Running it again adds only new rows. The first run asks for permission to connect to an external service (raw.githubusercontent.com).

| Field | Value for synced sheets |
| --- | --- |
| `print_id` | `S-` and 8 characters derived from the file path and prefix. |
| `timestamp_utc` | Last-modified time of the document in Google Drive. The print date is not recorded. |
| `name`, `program` | From the folder description: Mayuge Stationary / Mayuge, JHU / Kenya, Unknown / Colombia (PECET), Unknown / VectorCam. Edit `FOLDERS` in the build script to change them. |
| `start`, `end`, `codes` | Lowest and highest number, and the number of distinct codes (800 per prefix; the old sheets skip some numbers). |
| `reprint` | `TRUE` if the same codes also appear in an earlier folder of the archive. |
| `note` | Archive path of the document, and any inconsistency found. |

The archive contains the same codes in more than one folder:

- `AAE`–`AAZ`: the Mayuge sheets, and copies in `BA (Kenya, Printed at JHU)`.
- `AAE`, `AAF`, `AAK`–`AAP`: also copies in `VA (VectorCam Exclusive Sheets)`.
- `ADM`, `ADN`: `VCI_Perforated_ADM_ADN.docx`, and `VCI_Perforated_AEM_AEN.docx`, which holds ADM/ADN codes despite its name.

To add or correct sheets, update the archive or `FOLDERS`, rebuild, and import:

```
pip install python-docx
python3 scripts/build_synced_sheets.py data/legacy/Perforated_Sheet.zip data/synced_sheets.csv
```

Rows already in the Log tab are not changed by a new import. Correct them in the Google Sheet.

## CSV columns

| Column | Description |
| --- | --- |
| `print_id` | Unique ID: `P-` for prints, `S-` for synced sheets. Printed on the sheet for prints. |
| `timestamp_utc` | Time the range was logged, in UTC (`YYYY-MM-DDTHH:MM:SSZ`). For synced sheets, see above. |
| `name` | Name entered in the ID Printer. |
| `program` | Program entered in the ID Printer. |
| `prefix` | Three-letter prefix. |
| `start`, `end` | First and last number of the range. For prints, `start` is 8n+1 and `end` is a multiple of 8. |
| `first_code`, `last_code` | First and last code, for example `AIA001` and `AIA080`. |
| `codes` | Number of codes in the range. |
| `pages` | Number of pages. |
| `paper` | `A4` or `Letter`. |
| `reprint` | `TRUE` if the range overlapped a logged range (prints: allowed only for `TST`). |
| `source` | `print` (printed from the ID Printer) or `sync` (synced from the archive). |
| `note` | Synced sheets: archive path and any inconsistency. Empty for prints. |

### Allowing a reprint

Delete the row for the range from the **Log** tab of the Google Sheet. The range can then be printed again. The CSV in the repository is overwritten at the next sync, so edit the Google Sheet, not the CSV.

### Validating the CSV

```
python3 scripts/validate_print_log.py data/printed_sheets.csv
python3 scripts/validate_print_log.py data/synced_sheets.csv
```

The script checks the header, the format of each row, unique print IDs, and overlapping ranges.

### Limitations

- A range is logged when the print dialog opens. If the dialog is canceled, the range remains logged. Delete the row to release it.
- A saved PDF can be printed again outside the ID Printer.
- Names and programs are entered by the person printing and are not verified.
- This repository is public: `data/printed_sheets.csv` (including names and programs), `data/synced_sheets.csv` and the archived documents are public.
