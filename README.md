# Agar su Railway (client + server nello stesso servizio)

1. Carica questa cartella su GitHub (o `railway up`) come servizio Node.js.
2. Railway esegue `npm install` e `npm start`; nessuna variabile da impostare (usa `PORT`).
3. Apri `https://<tuo-dominio>/games/agar/` (la radice rimanda li): il client si collega a `wss://<tuo-dominio>/` da solo.

Regolazioni in `CFG` dentro `server.js` (mappa, cibo, virus, area visibile, ecc.).
Se il PHP non serve piu': `index.php` non e' necessario, il server Node serve `public/games/agar/game.html`.
