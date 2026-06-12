# Arugu Boys Auction

A real-time auction management app for running IPL-style auctions from a browser. The server broadcasts auction updates to all connected clients using Socket.IO, so teams, bids, sold/unsold status, and history stay in sync live.

## Features

- Add and manage teams with purse limits and logos
- Add players with base prices, roles, and photos
- Run live auction rounds with countdown timing
- Place bids and update the current highest bid in real time
- Mark players as sold or unsold
- View full auction history
- Undo the last sale or reset the auction state
- Search and filter players by name or role

## Tech Stack

- Node.js
- Express
- Socket.IO
- lowdb
- Multer

## Project Structure

- `server.js` — main Express server and API routes
- `db/` — local JSON database storage
- `public/` — frontend UI files
- `public/uploads/` — uploaded team/player images

## Run Locally

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

Data is stored in `db/data.json` automatically, and uploaded images are saved in `public/uploads/`.

## Deploy

This app can be deployed on services such as Render, Railway, or Fly.io.

### Suggested deployment settings

- Build Command: `npm install`
- Start Command: `npm start`
- Node.js version: `18+`

## Notes

- The app writes data to disk at runtime, so uploaded files and auction state may be lost on platforms with ephemeral storage after redeploys.
- For production persistence, consider using a cloud database and object storage.

## How It Works

- `server.js` handles the API and Socket.IO broadcasting
- `public/index.html` and `public/app.js` power the user interface
- `db/data.json` stores teams, players, history, and auction state using lowdb
