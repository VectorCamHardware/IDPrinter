# IDPrinter

Generates printable specimen ID sheets for VectorCam. Each sheet has rows of ID labels (for example `UGA001`–`UGA080`), a 15 mm reference, and the name / program of the person who printed it.

## Print log

Every printed sheet is recorded, and a range that has already been printed cannot be printed again.

```
index.html ──reserve──▶ Apps Script web app ──▶ Google Sheet ("Log" tab)
                                                       │
                     GitHub Action, every 6 hours ◀────┘
                                │
                                ▼
                     data/printed_sheets.csv (validated, committed)
```

- **Google Sheet:** the live log and the source of truth. `apps-script/Code.gs` runs as a web app bound to it.
- **Print button:** sends the range to the web app before printing. The web app refuses any range that overlaps a logged range for the same prefix and returns the next unprinted start number. Printing with Ctrl+P, without the button, prints only a notice.
- **`data/printed_sheets.csv`:** a copy of the log in the repository, updated by `.github/workflows/sync-printed-sheets.yml` every 6 hours, or on demand from the Actions tab. `scripts/validate_print_log.py` checks the export before it is committed.
- **Print ID:** each logged print receives an ID (for example `P-3F9A1C2B`), which is printed in the bottom margin of each page next to the name and program.
- **Test prefix:** `TST` ranges are logged but may be printed more than once (`REPRINT_ALLOWED` in `Code.gs`).


### CSV columns

| Column | Description |
| --- | --- |
| `print_id` | Unique ID of the print, also printed on the sheet. |
| `timestamp_utc` | Time the range was logged, in UTC (`YYYY-MM-DDTHH:MM:SSZ`). |
| `name` | Name entered in the ID Printer. |
| `program` | Program entered in the ID Printer. |
| `prefix` | Three-letter country or site prefix. |
| `start`, `end` | First and last number of the range. `start` is 8n+1 and `end` is a multiple of 8. |
| `first_code`, `last_code` | First and last printed code, for example `UGA001` and `UGA080`. |
| `codes` | Number of codes in the range. |
| `pages` | Number of pages. |
| `paper` | `A4` or `Letter`. |
| `reprint` | `TRUE` if the range overlapped a logged range (allowed only for `TST`). |

### Allowing a reprint

Delete the row for the range from the **Log** tab of the Google Sheet. The range can then be printed again. The CSV in the repository is overwritten at the next sync, so edit the Google Sheet, not the CSV.

### Validating the CSV

```
python3 scripts/validate_print_log.py data/printed_sheets.csv
```

The script checks the header, the format of each row, unique print IDs, and overlapping ranges.

### Limitations

- A range is logged when the print dialog opens. If the dialog is canceled, the range remains logged. Delete the row to release it.
- A saved PDF can be printed again outside the ID Printer.
- Names and programs are entered by the person printing and are not verified.
- If this repository is public, `data/printed_sheets.csv`, including names and programs, is public.
