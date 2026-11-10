# VCID Generator

Generates VectorCam device IDs (VCIDs) in batches and exports them for label printing.

**Open the tool: https://vectorcamhardware.github.io/VCID/**

This repository holds only the published page. The page sends each batch to the VCID log, a Google Sheet behind a Google Apps Script web app, which refuses any VCID that was already issued.

The source, the Apps Script backend and the log are kept in a private repository, because the log contains the names of the people who reserved batches. Changes to the page are made there and copied here, so do not edit `index.html` in this repository.

Questions: vectorcamhardware@gmail.com
