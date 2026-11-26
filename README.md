# CardBlanche

Which card to use for every purchase, the full history of every card (opened, product switches, closed), and pay runs that replace the monthly card-payment spreadsheet. Installable on Android and on a laptop browser; works offline.

- The app lives here and is served by GitHub Pages. **It holds no personal data.**
- Cards, history, pay runs and settings live in a separate **private** repo (`card-wallet-data`). Each device keeps a copy and syncs with it through the GitHub API, using a fine-grained token limited to that one repo (Contents: read/write). The token is stored only in that device's browser.
- Card earn rates and fees come from `catalog.js` (Prince of Travel, Nov 2026); point values from Prince of Travel's points valuations.
