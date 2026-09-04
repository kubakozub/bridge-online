# Bridge Online

> **Gra na żywo: [brydz.uk](https://brydz.uk)**
> Otwórz na dwóch komputerach — jedna osoba tworzy stół, druga wchodzi sześcioznakowym kodem.

Brydż porównawczy przez przeglądarkę **dla dwóch osób w dwóch różnych miejscach**. Jedna osoba
tworzy stół, druga wchodzi sześcioznakowym kodem. Wolne krzesła obsadzają roboty, więc do gry
wystarczą dwie osoby — nie cztery.

Całość stoi na Cloudflare: Worker serwuje klienta, a każdy stół to jeden Durable Object, który
jest jedynym właścicielem rozdania.

---

## Co potrafi

**Pełne reguły brydża, nie uproszczenia**

- Licytacja z kompletem reguł legalności: wystarczalność odzywki, kontra tylko na przeciwnika,
  rekontra tylko przez strona skontrowaną, zamknięcie po trzech pasach.
- Wyznaczenie rozgrywającego wg prawa: rozgrywa ten z pary, kto **pierwszy** wymienił kolor
  końcowego kontraktu — nie ten, kto zalicytował ostatni.
- Rozgrywka: przymus dokładania do koloru, przebitki, bierze lewę najwyższy atut albo najwyższa
  karta koloru wistu, rozgrywający gra kartami dziadka.
- Punktacja turniejowa: zapis częściowy, dopłaty za partię i szlemiki, premia „za obrazę”
  przy kontrze, pełna drabinka wpadek skontrowanych, przeliczenie na IMP-y wg tabeli WBF.
- Rozdający i założenia zmieniają się wg 16-rozdaniowego cyklu turniejowego.
- Zapowiedź lew (claim) z akceptacją przeciwników, cofnięcie ruchu za zgodą, zapis rozdań w PBN.

**Gra we dwoje przez sieć**

- Autorytatywny serwer: pełne rozdania **nigdy** nie opuszczają Durable Objectu. Każdy gracz
  dostaje własną, ocenzurowaną wersję stanu — cudzych kart nie da się podejrzeć w zakładce Sieć.
- Powrót po rozłączeniu: zamknięcie laptopa nie kończy rozdania. Po ponownym wejściu wracasz na
  swoje miejsce z tymi samymi kartami.
- Jeśli ktoś zniknie na dłużej niż 45 sekund, jego miejsce tymczasowo obsługuje robot, żeby
  druga osoba nie stała w miejscu.
- Opcjonalny zegar na ruch, czat przy stole, obserwatorzy.

**Roboty**

Trzy poziomy (nowicjusz / średni / zaawansowany). Licytują w konwencji SAYC (piątkowe starsze,
1BA 15–17, Stayman, transfery, kontra wywoławcza), a w rozgrywce stosują standardowe zasady
wistu i obrony plus przeszukanie końcówki.

---

## Uruchomienie lokalne

```bash
npm install
```

Klient i Worker startują razem:

```bash
npm run dev
```

Vite stoi na `http://localhost:5173` i przekazuje `/api/*` (razem z WebSocketem) do `wrangler dev`
na porcie 8787.

Żeby zagrać samemu ze sobą, otwórz ten sam link w oknie normalnym i w oknie prywatnym — to dwie
osobne tożsamości, więc siądziesz na dwóch różnych krzesłach.

Testy i kontrola typów:

```bash
npm test
npm run typecheck
```

### Jeśli `wrangler dev` nie startuje

Na tej maszynie `wrangler dev` przewraca się z komunikatem `spawn UNKNOWN`, bo **Windows App
Control blokuje `workerd.exe`** — silnik uruchomieniowy Cloudflare, który wrangler rozpakowuje
do `node_modules`. Sprawdzisz to tak:

```powershell
& ".\node_modules\@cloudflare\workerd-windows-64\bin\workerd.exe" --version
```

Jeśli odpowie „Zasady kontroli aplikacji zablokowały ten plik", to polityka bezpieczeństwa
komputera, nie błąd projektu — bundling działa (`npx wrangler deploy --dry-run` przechodzi),
więc wdrożenie na Cloudflare i tak się uda. Do pracy lokalnej masz dwie drogi:

- `npm run dev:client` — sam interfejs na Vite (bez serwera gry, ale cała warstwa wizualna
  działa, łącznie z podglądem talii pod `/dev/cards.html`);
- `npm run dev:remote` — interfejs lokalnie z hot-reloadem, ale `/api` i WebSocket kierowane na
  **wdrożonego** Workera, czyli praca na prawdziwej grze bez lokalnego `workerd`. Inny cel
  wskażesz zmienną:

  ```bash
  BRIDGE_REMOTE=https://brydz.uk npm run dev:remote
  ```

  > Uwaga: tego trybu nie udało się przetestować end-to-end na tej maszynie — proces Vite nie
  > dostał połączenia wychodzącego (DNS wracał z puli discard `100::`). Sam mechanizm proxy jest
  > zwykłą konfiguracją Vite, ale traktuj go jako niesprawdzony, dopóki nie odpalisz go u siebie.

- `npm test` — logika stołu jest w całości pokryta testami, które uruchamiają Durable Object na
  atrapach środowiska Cloudflare (`tests/table.integration.test.ts`), więc nie potrzebują
  `workerd`.

Docelowo poproś administratora o dopuszczenie `workerd.exe` w App Control albo uruchom projekt
na maszynie bez tej polityki.

---

## Wdrożenie na Cloudflare

Potrzebne raz: zalogowanie wranglera.

```bash
npx wrangler login
```

Albo, w CI, przez zmienne środowiskowe `CLOUDFLARE_API_TOKEN` i `CLOUDFLARE_ACCOUNT_ID`
(token z uprawnieniami *Workers Scripts: Edit* oraz *Workers Durable Objects: Edit*).

Potem:

```bash
npm run deploy
```

To buduje klienta do `dist/client` i wypycha Workera razem z zasobami statycznymi. Gra jest
dostępna pod adresem https://brydz.uk (adres `*.workers.dev` jest wyłączony w `wrangler.jsonc`).

Durable Objects z magazynem SQLite działają na planie darmowym — migracja `v1` w
`wrangler.jsonc` tworzy klasę `TableDurableObject` przy pierwszym wdrożeniu.

### Własna domena

W `wrangler.jsonc` dopisz:

```jsonc
"routes": [{ "pattern": "brydz.twojadomena.pl", "custom_domain": true }]
```

---

## Architektura

```
przeglądarka A ─┐
                ├─ WebSocket ─→ Worker ─→ Durable Object „ABC123”
przeglądarka B ─┘                         (jedyna kopia rozdania na świecie)
```

```
src/
  engine/     czysty silnik reguł — bez I/O, bez losowości poza jawnym ziarnem
    types.ts    kontrakt domenowy; format sieciowy = format silnika ("SA", "3N", "P")
    cards.ts    talia, tasowanie z ziarna, ocena ręki, PBN
    deal.ts     rozdający i założenia wg numeru rozdania
    auction.ts  automat licytacji, wyznaczenie rozgrywającego
    play.ts     legalność zagrania, rozstrzyganie lew, widoczność rąk
    scoring.ts  punktacja turniejowa, IMP-y, maksy
    game.ts     JEDYNE wejście zmieniające stan: applyAction(state, action)
  bots/       roboty: licytacja SAYC + rozgrywka heurystyczna
  server/
    protocol.ts wiadomości klient↔serwer
    table.ts    Durable Object: stan stołu, cenzura kart, zegary, roboty
    index.ts    router Workera + zasoby statyczne
  client/     React 18, bez dodatkowych zależności
```

Zasada, która trzyma to w kupie: **stan zmienia się wyłącznie przez `applyAction`**, funkcję
czystą, która zwraca nowy stan albo błąd i nigdy nie rzuca wyjątkiem. Durable Object jest cienką
warstwą wokół niej — dzięki temu regułę brydża da się przetestować bez sieci, a test fuzzowy
rozgrywa 150 pełnych rozdań, sprawdzając po każdym ruchu, że żadna karta nie zniknęła.

---

## Grafika

Talia i cała grafika interfejsu pochodzą z paczki Claude Design (brief:
[`docs/CLAUDE-DESIGN-PROMPT.md`](docs/CLAUDE-DESIGN-PROMPT.md)). Wgranie nowej paczki to dwa polecenia:

```bash
node scripts/import-art.mjs <katalog-z-rozpakowaną-paczką>
node scripts/embed-art.mjs
```

`import-art` **wycina metadane C2PA** (~7,7 KB podpisu pochodzenia w każdym pliku — w awatarze na
8 KB rysunek to 0,4 KB), waliduje kontrakt z sekcji 5 briefu i odmawia importu pliku, który go łamie.
Jeśli w paczce jest talia (`public/cards/sprite.svg`), po imporcie uruchom jeszcze
`node scripts/embed-sprite.mjs` — sprawdza komplet 52 kart i `viewBox 0 0 240 336`.

`embed-art` składa `public/art/*.svg` w jeden sprite i wbudowuje go w bundle
(`src/client/assets/artSprite.ts`). Dlaczego inline, a nie `<img>`: rysunki biorą kolory ze zmiennych
CSS, które **nie przenikają** do SVG ładowanego jako obraz zewnętrzny — w `<img>` na ciemnym suknie
pokazałyby się jasne fallbacki. Wstrzyknięty do DOM sprite dziedziczy kaskadę strony.

W kodzie: `<Art id="art-logo-mark"/>`, `<Icon name="copy"/>`, `avatarIdFor(playerId)`,
`robotIdFor(level)` — patrz `src/client/components/Art.tsx`. Dostępne `id` wylicza `ART_IDS`.

Podgląd talii: `/dev/cards.html` przy działającym serwerze deweloperskim. Talia awaryjna,
generowana proceduralnie: `npm run cards`.

---

## Ograniczenia, o których warto wiedzieć

- Roboty grają poprawnie i sensownie, ale nie są silnikiem klasy GIB — nie liczą rozgrywki
  podwójnie martwej poza końcówką.
- Punktacja „rubber” jest uproszczona do podziału nad/pod kreską; tryb turniejowy i IMP są pełne.
- Maksy liczone są względem tego jednego stołu, więc mają sens dopiero przy zapisie wielu stołów.
