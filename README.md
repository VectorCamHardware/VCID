# VCID Generator

Generates VectorCam device IDs (VCIDs) in batches and exports each batch as an Excel file for label printing.

A VCID has 17 characters and no separators:

| Characters | Field | Example |
| --- | --- | --- |
| 1–2 | Prefix: `VC` VectorCam, `VT` VectorCatch, `VP` Phone | `VC` |
| 3–5 | Manufacturer code | `JHU` |
| 6–7 | Year of manufacture | `26` |
| 8–9 | Month of manufacture | `10` |
| 10–12 | Model number | `001` |
| 13–16 | Unit number | `0001` |
| 17 | Damm check digit over characters 6–16 | `9` |

Example: `VCJHU261000100019`.

## VCID log

Every batch is reserved in the VCID log before it can be downloaded, shared or copied. The log has one row per device, and a VCID that has already been issued cannot be issued again.

```
index.html ──reserve──▶ Apps Script web app ──▶ Google Sheet (one tab per prefix)
                                                       │
                     GitHub Action, every 6 hours ◀────┘
                                │
                                ▼
                     data/vcid_log.csv (validated, committed)
```

- **Google Sheet:** the live log and the source of truth. `apps-script/Code.gs` runs as a web app bound to it. Each prefix has its own tab: **VectorCam (VC)**, **VectorCatch (VT)** and **Phone (VP)**. Each reserved device is one row on the tab for its prefix.
- **Reserve batch:** sends the batch to the web app. The web app refuses any batch that contains a VCID already on the tab, and returns the next unissued unit number. Only a reserved batch can be downloaded, shared or copied.
- **Start unit number:** filled in from the log whenever the prefix, manufacturer, month or model changes. Unit numbers start again at 0001 each month, because the month is part of the VCID.
- **Batch ID:** each reserved batch receives an ID (for example `B-3F9A1C2B`), recorded on every row of the batch.
- **`data/vcid_log.csv`:** a copy of all tabs in one file in the repository, updated by `.github/workflows/sync-vcid-log.yml` every 6 hours, or on demand from the Actions tab. `scripts/validate_vcid_log.py` checks the export before it is committed.

### Setup

1. Create a Google Sheet named **VCID Log**.
2. In the sheet, open **Extensions → Apps Script**, replace the contents of `Code.gs` with `apps-script/Code.gs` from this repository, and save.
3. Select **Deploy → New deployment**, choose the type **Web app**, set **Execute as** to **Me** and **Who has access** to **Anyone**, and select **Deploy**. Authorize the script when asked. If Google shows "Google hasn't verified this app", select **Advanced → Go to (project name)**.
4. Copy the web app URL (it ends in `/exec`) into the `API_URL` constant in `index.html` and commit the change.
5. Optional, for the repository copy of the log: in the Apps Script project, open **Project Settings → Script properties** and add `EXPORT_TOKEN` with a long random value. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add the secrets `VCID_LOG_URL` (the web app URL) and `VCID_LOG_TOKEN` (the same token).

Each prefix tab and its header row are created the first time that prefix is used. The tabs are found by name, so do not rename them; to rename one, change `TABS` in `Code.gs` and the tab together.

After a change to `Code.gs`, select **Deploy → Manage deployments**, edit the deployment and choose **New version**. The web app URL stays the same.

### CSV columns

The prefix tabs and the CSV have the same columns, one row per device.

| Column | Description |
| --- | --- |
| `vcid` | The device's VCID. |
| `batch_id` | ID of the batch the device was reserved in. |
| `timestamp_utc` | Time the batch was reserved, in UTC (`YYYY-MM-DDTHH:MM:SSZ`). |
| `name` | Name entered in the VCID Generator. |
| `prefix` | `VC`, `VT` or `VP`. |
| `manufacturer` | Three-letter manufacturer code. |
| `year`, `month` | Two-digit year and month of manufacture. |
| `model` | Three-digit model number. |
| `unit` | Four-digit unit number. |

### Releasing VCIDs

Delete the rows for the VCIDs from their prefix tab of the Google Sheet. Their unit numbers can then be issued again. The CSV in the repository is overwritten at the next sync, so edit the Google Sheet, not the CSV.

### Validating the CSV

```
python3 scripts/validate_vcid_log.py data/vcid_log.csv
```

The script checks the header, the format of each row, the check digits, that each VCID appears once, and that the rows of each batch agree.

### Limitations

- A batch is logged when it is reserved. If its labels are never printed, the batch remains logged. Delete its rows to release it.
- A downloaded Excel file can be printed more than once outside the VCID Generator.
- Names are entered by the person reserving the batch and are not verified.
- Year and month come from the clock of the device running the page. The web app refuses a month that is not current.
- If this repository is public, `data/vcid_log.csv`, including names, is public.
