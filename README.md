# ID Printer

Prints VectorCam specimen ID sheets: rows of ID labels (for example `AIA001` to `AIA080`), a 15 mm reference, and the name and program of the person who printed them.

**Open the tool: https://vectorcamhardware.github.io/IDPrinter/**

This repository holds only the published page. Every printed range is recorded in the print log, a Google Sheet behind a Google Apps Script web app, so automatic prefixes are never printed twice.

The source, the Apps Script backend and the print log are kept in a private repository, because the log contains the names and programs of the people who printed sheets. Changes to the page are made there and copied here, so do not edit `index.html` in this repository.

Earlier versions of this repository, including the print log up to November 2026, remain in its history.

Questions: vectorcamhardware@gmail.com
