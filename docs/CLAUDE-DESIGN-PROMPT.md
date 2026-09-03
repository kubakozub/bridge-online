# Mega prompt dla Claude Design — komplet grafiki do „Bridge Online”

> **Jak używać:** skopiuj wszystko poniżej linii `--- POCZĄTEK PROMPTU ---` i wklej do Claude
> Design jako jedną wiadomość. Prompt jest samowystarczalny — zawiera brief produktowy, kierunek
> artystyczny, tokeny kolorów zgodne z kodem, pełny manifest zasobów oraz **kontrakt
> integracyjny** (ID symboli, `viewBox`, nazwy zmiennych CSS). Dzięki temu wynik wchodzi do
> repozytorium bez przerabiania kodu.
>
> Jeśli chcesz podzielić pracę na mniejsze zlecenia — każda sekcja „PAKIET n” jest samodzielnym
> promptem; wtedy wklej **Sekcje 1–4** (kontekst + kierunek + tokeny + kontrakt techniczny)
> plus wybrany pakiet.

---

--- POCZĄTEK PROMPTU ---

Jesteś dyrektorem artystycznym i ilustratorem. Zaprojektuj **komplet grafiki wektorowej** dla
gotowej, działającej aplikacji webowej **Bridge Online** — brydża porównawczego dla dwóch osób
grających zdalnie. Poniżej masz pełny kontekst, sztywne ograniczenia techniczne i manifest
zasobów. Trzymaj się ich dosłownie: grafika ma wpaść do istniejącego kodu bez zmian w kodzie.

## SEKCJA 1 — Brief produktowy

**Co to jest.** Przeglądarkowa gra w brydża sportowego. Dwie osoby w dwóch różnych miastach
wchodzą na ten sam link, siadają przy wirtualnym stole, a wolne krzesła obsadzają roboty.
Rozgrywa się licytację (bidding box), a potem 13 lew. Wynik liczony jest punktacją turniejową.

**Kto gra.** Dwie grupy naraz:
- Osoby po 50–70 roku życia, znające brydża z klubu i ze stołu fizycznego. Grają na laptopie
  lub tablecie, często w okularach, czasem przy słabym świetle. **Czytelność jest ważniejsza
  niż efekt.**
- Osoby 25–40 lat uczące się brydża, grające na telefonie w pionie (360–430 px szerokości).

**Konkurencja / punkt odniesienia.** 247bridge.com i BBO (Bridge Base Online) są funkcjonalne,
ale wyglądają jak oprogramowanie z 2006 roku: jaskrawa zieleń, gradienty z Web 2.0, przypadkowa
typografia. Naszą przewagą ma być wygląd **spokojnego, drogiego klubu brydżowego** — a nie
kasyna i nie „gierki mobilnej”.

**Emocja docelowa.** Cichy pokój, ciemnozielone sukno, mosiądz, drewno, dobre światło znad stołu.
Skupienie, nie ekscytacja. Zero hazardu, zero żetonów, zero neonów, zero cartoonowych maskotek.

## SEKCJA 2 — Kierunek artystyczny

**Rób tak:**
- Płaski wektor z **jednym** subtelnym źródłem światła z góry. Cienie miękkie, nisko kontrastowe.
- Formy geometryczne, precyzyjne, z wyraźną siatką. Grubości linii spójne w całym zestawie
  (2 px i 2.5 px w układzie odniesienia 240×336).
- Paleta wąska i stonowana — patrz Sekcja 3. Akcent mosiężny stosuj oszczędnie, tylko tam gdzie
  ma prowadzić wzrok (aktywne krzesło, główny przycisk).
- Heraldyka i typografia zamiast ilustracji rodzajowej. Figury (W, D, K) mają być **sylwetkami
  z godła** — korona, diadem, pióropusz — a nie portretami postaci.
- Wszystko musi być czytelne przy **28 px wysokości** (karta na telefonie w bocznej ręce).
  Testuj każdy zasób zmniejszony do 15% zanim uznasz go za skończony.

**Nie rób tak:**
- Bez gradientów tęczowych, bez blasku/glow, bez skosów, bez faz 3D, bez tekstur „drewna” z
  fotografii, bez efektu szkła.
- Bez cieni rzucanych pod wieloma kątami — jedno światło, jeden kierunek.
- Bez cienkich linii poniżej 1.5 px w układzie 240×336 (znikną na telefonie).
- Bez tekstu w grafice poza wartościami kart (2–10, W, D, K, A) i logotypem.
- **Bez naśladowania istniejących marek** — nie kopiuj logo ani stylistyki 247bridge, BBO,
  Bicycle, Piatnik ani żadnego realnego wydawcy kart.

**Znaki kolorów kart.** Domyślnie talia dwukolorowa (pik i trefl czarne, kier i karo czerwone).
Musi jednak działać też tryb **czterokolorowy** (karo niebieskie, trefl zielony) — to realna
funkcja dostępności, bo mylenie kierów z karami jest najczęstszym błędem w brydżu online.
Dlatego kolor pobierasz **wyłącznie** ze zmiennych CSS z Sekcji 3, nigdy nie wpisujesz go na
sztywno w ścieżkę.

## SEKCJA 3 — Tokeny kolorów (skopiuj wartości dokładnie)

Motyw ciemny „felt” (domyślny):

```
--felt-1        #0d2b22   tło strony, najgłębsze sukno
--felt-2        #12382c   blat stołu
--felt-3        #174535   pole lewy (wyżej położone sukno)
--felt-rail     #3a2317   drewniana krawędź stołu
--felt-rail-hi  #5c3a26   rozjaśnienie krawędzi

--surface-1     #10201c   panele
--surface-2     #16302a
--surface-3     #1e3f37

--text-1        #f2f6f3   tekst główny
--text-2        #b9c9c1   tekst drugorzędny
--text-3        #7d938a   tekst wyłączony

--accent        #f0c05a   mosiądz — kolor akcji
--info          #6cb8e6
--success       #64c98a
--warning       #e8a13c
--danger        #e2604f

--card-face     #fdfdfb   awers karty
--card-edge     rgba(10,20,16,.35)  krawędź karty
--card-back     #123c5a   rewers karty
--card-back-ink rgba(255,255,255,.55)

--suit-spade    #16161d
--suit-heart    #c8102e
--suit-diamond  #c8102e   (w trybie 4-kolorowym #1c62c4)
--suit-club     #16161d   (w trybie 4-kolorowym #157a45)
```

Motyw jasny „daylight” — dla grających w pełnym słońcu. Sukno `#1f6b52`, tło `#e8ece7`, tekst
`#16211d`, akcent `#b8801a`. Zasoby mają działać w obu motywach; osiągasz to używając zmiennych,
a nie projektując dwóch wersji.

**Typografia w kodzie:** UI = Inter (400/500/600/700). Nagłówki i wartości kart = Source Serif 4
(600/700). Jeśli w grafice potrzebujesz liter, **zamień je na krzywe** — pliki nie mogą zależeć
od fontu zainstalowanego u gracza.

## SEKCJA 4 — Kontrakt techniczny (naruszenie = grafika nie wejdzie do kodu)

1. **Format: SVG.** Bez PNG, bez JPG, bez rastrów osadzonych w SVG. Wyjątek: obraz OG do
   udostępniania w social media (Pakiet 7) — tam PNG 1200×630.
2. **Karty i godła oddajesz jako jeden sprite** — plik `sprite.svg` o strukturze:
   ```xml
   <svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
     <symbol id="card-SA" viewBox="0 0 240 336"> ... </symbol>
     <symbol id="card-HT" viewBox="0 0 240 336"> ... </symbol>
     ...
     <symbol id="card-back" viewBox="0 0 240 336"> ... </symbol>
     <symbol id="suit-S" viewBox="0 0 100 100"> ... </symbol>
     <symbol id="suit-S-mono" viewBox="0 0 100 100"> ... </symbol>
     ...
   </svg>
   ```
3. **Identyfikatory symboli są sztywne.** `card-` + litera koloru + znak wartości:
   - kolory: `S` pik, `H` kier, `D` karo, `C` trefl
   - wartości: `2 3 4 5 6 7 8 9 T J Q K A` (`T` = dziesiątka, `J` = walet, `Q` = dama, `K` = król)
   - czyli 52 symbole: `card-S2` … `card-SA`, `card-H2` … `card-CA`
   - dodatkowo: `card-back`, oraz `suit-S`/`suit-H`/`suit-D`/`suit-C` i ich warianty
     `suit-S-mono` … (mono = wypełnienie `currentColor`, do przycisków i tabeli licytacji)
4. **`viewBox` kart to dokładnie `0 0 240 336`** (proporcja 2.5 : 3.5). Rewers ten sam.
   Godła kolorów: `0 0 100 100`, wyśrodkowane, wypełniające ~92% pola.
5. **Kolory tylko przez zmienne CSS z literalnym fallbackiem**, np.
   `fill="var(--suit-heart, #c8102e)"`, `fill="var(--card-face, #fdfdfb)"`.
   Sprite jest wklejany do DOM, więc zmienne ze strony zadziałają.
6. **Zero `<style>`, zero `<script>`, zero `class`, zero `id` wewnątrz symboli** (poza `id`
   samego `<symbol>`). Atrybuty prezentacji wpisujesz bezpośrednio w elementy.
7. **Zero odwołań zewnętrznych** — żadnych `<image href="http...">`, żadnych `@font-face`.
8. Ścieżki zoptymalizowane (współrzędne do 2 miejsc po przecinku). Cel: **cały sprite ≤ 180 KB**
   przed kompresją.
9. Każdy zasób poza sprite'em oddajesz jako osobny plik SVG o nazwie z manifestu, z `viewBox`
   podanym w manifeście i **bez** sztywnych `width`/`height`.

Referencja: obecny, wygenerowany proceduralnie sprite leży w repo pod `public/cards/sprite.svg`,
a stronę podglądu masz pod `/dev/cards.html`. Twoja wersja ma go zastąpić 1:1 — te same ID, ten
sam `viewBox`, wyższa jakość rysunku.

---

## PAKIET 1 — Talia (najważniejszy, zrób go najpierw)

**1.1 Awersy blotek (2–10), 4 kolory = 36 kart.**
Klasyczny układ oczek w siatce 3 kolumn × 7 rzędów. Dolna połowa oczek obrócona o 180°, tak jak
na prawdziwej talii. Indeks w dwóch przeciwległych narożnikach: wartość + małe godło koloru,
narożnik lewy górny i prawy dolny (obrócony). Indeks musi być czytelny, gdy widać tylko 22 px
lewej krawędzi karty — tak leżą karty w rozwiniętym wachlarzu.

**1.2 Figury: walet (J), dama (Q), król (K) — 12 kart.**
Sylwetki heraldyczne, symetryczne względem środka karty (górna połowa odbita w dolnej), w ramce.
Walet = pióropusz / fleur-de-lis. Dama = diadem z trzema kamieniami. Król = korona z pięcioma
zębami. Sylwetka w kolorze koloru karty, ramka cienka, tło awersu czyste. Każdy kolor dostaje
**inny detal wypełnienia**, żeby figury nie były nierozróżnialne w skali — ale ta sama sylwetka
bazowa.

**1.3 Asy — 4 karty.**
Duże, ozdobne godło na środku (≈120 px w układzie 240×336). As pik dostaje najbogatszą oprawę
(tradycja), pozostałe skromniejszą.

**1.4 Rewers `card-back`.**
Wzór giloszowy: regularna, drobna plecionka w `--card-back-ink` na tle `--card-back`, z
podwójną ramką i centralną rozetą z czterema godłami kolorów. Wzór ma być **bezszwowy w obrębie
karty** i nie może dawać efektu mory przy zmniejszeniu do 30 px. Zaprojektuj **trzy warianty
kolorystyczne** rewersu (granat, bordo, las) jako `card-back`, `card-back-crimson`,
`card-back-forest` — gracz wybiera w ustawieniach.

**1.5 Godła kolorów** — `suit-S/H/D/C` + warianty `-mono`.
Cztery klasyczne kształty, wyważone optycznie: przy tej samej wysokości mają wyglądać na tak
samo „ciężkie”. Trefl to trzy koła + nóżka, pik to odwrócone serce z nóżką, karo to romb o
lekko wklęsłych bokach, kier to serce o miękkim wcięciu.

## PAKIET 2 — Stół

**2.1 `table-felt.svg`** (`viewBox="0 0 1600 1000"`) — blat: zaokrąglony prostokąt sukna
`--felt-2` z delikatnym rozświetleniem radialnym u góry, otoczony drewnianą krawędzią
`--felt-rail` z rozjaśnieniem `--felt-rail-hi` od strony światła. Tekstura sukna jako bardzo
subtelny szum wektorowy (drobne kreski o `opacity` ≤ 0.05), nie jako bitmapa.

**2.2 `trick-well.svg`** (`viewBox="0 0 400 400"`) — wgłębienie na środku stołu, gdzie lądują
cztery karty lewy: ledwie widoczny okrąg ciemniejszego sukna z miękkim cieniem wewnętrznym.

**2.3 `vulnerability.svg`** (`viewBox="0 0 100 100"`) — klasyczny romb podzielony na cztery
ćwiartki (N, E, S, W). Ćwiartka strony „po partii” ma być czerwona `--danger`, „przed partią”
zielona. Oddaj **cztery warianty**: `vul-none`, `vul-ns`, `vul-ew`, `vul-both`.

**2.4 `dealer-marker.svg`** (`viewBox="0 0 100 100"`) — okrągły mosiężny żeton z literą „R”
(rozdający), litera zamieniona na krzywe.

## PAKIET 3 — Gracze przy stole

**3.1 Awatary robotów — 3 sztuki**, `robot-beginner.svg`, `robot-intermediate.svg`,
`robot-advanced.svg`, `viewBox="0 0 120 120"`. Geometryczne, spokojne „głowy” w kole. Poziom
sygnalizowany liczbą elementów i kolorem obwódki (zielony / mosiężny / niebieski), **nie**
gwiazdkami i nie cartoonową mimiką. Mają wyglądać na partnera do brydża, nie na zabawkę.

**3.2 Awatary graczy — 8 abstrakcyjnych** `avatar-01.svg` … `avatar-08.svg`,
`viewBox="0 0 120 120"`. Godła w kole: kotwica, liść, kompas, klepsydra, klucz, pióro, latarnia,
żagiel. Jednokolorowe na tle `--surface-3`, przypisywane automatycznie po ID gracza.

**3.3 `seat-ring.svg`** (`viewBox="0 0 200 200"`) — pierścień podświetlający krzesło gracza,
którego jest kolej. Przerwa u dołu na łuk odliczania czasu (kod rysuje łuk sam przez
`stroke-dashoffset`, ty dajesz tło pierścienia).

**3.4 `connection-dot.svg`** — trzy stany w jednym pliku jako trzy symbole:
`conn-online`, `conn-away`, `conn-offline`.

## PAKIET 4 — Licytacja

**4.1 Pastylki licytacyjne.** Nie rysuj 35 osobnych plików — oddaj **jeden szablon**
`bid-chip.svg` (`viewBox="0 0 120 84"`): zaokrąglony prostokąt z miejscem na cyfrę poziomu po
lewej i godło koloru po prawej, plus warianty stanu jako osobne symbole: `bid-chip`,
`bid-chip-disabled`, `bid-chip-hint`.

**4.2 Trzy przyciski specjalne**, `viewBox="0 0 160 84"`:
`call-pass` (PAS, zielony), `call-double` (KONTRA — duże „X”, czerwony),
`call-redouble` (REKONTRA — „XX”, niebieski). Litery na krzywych.

**4.3 `contract-plate.svg`** (`viewBox="0 0 240 90"`) — mosiężna tabliczka, na której kod
wypisuje zawarty kontrakt (np. „4♠ ×  rozgrywa W”). Sama tabliczka, bez tekstu.

## PAKIET 5 — Ikony interfejsu

Jeden plik `icons.svg` ze sprite'em, `viewBox="0 0 24 24"`, linia 1.75 px, zaokrąglone końce,
wypełnienie `currentColor`, ID zgodne z listą:

`icon-copy`, `icon-check`, `icon-share`, `icon-settings`, `icon-chat`, `icon-score`,
`icon-undo`, `icon-claim`, `icon-leave`, `icon-sit`, `icon-robot`, `icon-sound-on`,
`icon-sound-off`, `icon-theme-dark`, `icon-theme-light`, `icon-deck-two`, `icon-deck-four`,
`icon-help`, `icon-close`, `icon-chevron`, `icon-clock`, `icon-wifi`, `icon-wifi-off`,
`icon-crown` (rozgrywający), `icon-eye` (dziadek), `icon-next-board`, `icon-history`,
`icon-hcp` (punkty honorowe), `icon-menu`, `icon-link`.

## PAKIET 6 — Marka

**6.1 `logo-full.svg`** (`viewBox="0 0 480 120"`) — sygnet + logotyp „Bridge Online”.
Sygnet: cztery godła kolorów ułożone w formę mostu / łuku — most jest tu dosłowną i trafną
metaforą (bridge + dwoje ludzi w dwóch miejscach połączonych łukiem). Logotyp złożony
z Source Serif 4 zamienionego na krzywe.

**6.2 `logo-mark.svg`** (`viewBox="0 0 120 120"`) — sam sygnet, do awatara i nagłówka.

**6.3 `favicon.svg`** (`viewBox="0 0 32 32"`) — maksymalne uproszczenie sygnetu; musi być
rozpoznawalny przy 16 px. Dodatkowo `favicon-mono.svg` na jednolitym tle dla trybu ciemnego.

**6.4 `empty-table.svg`** (`viewBox="0 0 400 300"`) — ilustracja pustego stanu „Czekamy na
drugiego gracza”: dwa krzesła po przeciwnych stronach stołu, jedno puste. Spokojna, jednobarwna,
z akcentem mosiężnym. Bez tekstu.

## PAKIET 7 — Udostępnianie

**7.1 `og-image.png`** — 1200×630 PNG. Ciemne sukno, sygnet, hasło „Brydż online dla dwojga”
i wachlarz czterech kart. Jedyny raster w całym zestawie.

**7.2 `qr-frame.svg`** (`viewBox="0 0 300 380"`) — ozdobna ramka pod kod QR z linkiem do stołu,
z miejscem na sześcioznakowy kod pokoju pod spodem.

## SEKCJA 5 — Jak oddajesz pracę

1. Zacznij od **Pakietu 1**, pokaż mi arkusz kontrolny: wszystkie 52 karty w siatce w trzech
   skalach — 96 px, 52 px i 28 px wysokości — na tle `--felt-2`. Dopiero po akceptacji rób resztę.
2. Dla każdego pakietu podaj: listę plików, ID symboli, `viewBox`, rozmiar po optymalizacji.
3. Na koniec oddaj jeden arkusz przeglądowy `docs/design-sheet.svg` z całym zestawem.

## SEKCJA 6 — Kryteria akceptacji (sprawdź sam przed oddaniem)

- [ ] 52 karty + rewers + 8 godeł mają **dokładnie** ID i `viewBox` z Sekcji 4.
- [ ] Każdy kolor pochodzi ze zmiennej CSS z fallbackiem; przełączenie na talię czterokolorową
      zmienia tylko karo i trefl i nie psuje niczego innego.
- [ ] Wartość i kolor karty da się odczytać z samego narożnika przy 28 px wysokości karty.
- [ ] Kier i karo są rozróżnialne w skali szarości (test: usuń kolor — kształty muszą wystarczyć).
- [ ] Sprite waży ≤ 180 KB, nie zawiera `<script>`, `<style>`, `class`, `@font-face` ani
      odwołań zewnętrznych.
- [ ] Wszystkie napisy zamienione na krzywe.
- [ ] Zestaw wygląda spójnie w motywie ciemnym i jasnym.
- [ ] Nic nie przypomina logo ani stylistyki istniejącej marki kart czy serwisu brydżowego.

--- KONIEC PROMPTU ---

---

## Jak wgrać wynik do repozytorium

1. Podmień `public/cards/sprite.svg` na plik z Pakietu 1.
2. Przegeneruj wersję wbudowaną w bundle:
   ```bash
   node scripts/embed-sprite.mjs
   ```
   (skrypt bierze `public/cards/sprite.svg` i zapisuje `src/client/assets/cardSprite.ts`;
   jeśli chcesz wrócić do talii proceduralnej — `npm run cards`).
3. Pozostałe pliki wrzuć do `public/art/`, a ikony do `public/art/icons.svg`.
4. Sprawdź wizualnie pod `/dev/cards.html`, a potem zagraj jedno rozdanie.

---

## Stan realizacji (aktualizowane 30.08.2026)

| Pakiet | Stan | Uwagi |
|---|---|---|
| 1 — Talia | **ODEBRANY, wdrożony** | `sprite.svg` 171 KB, 63 symbole (52 karty + 3 rewersy + 8 godeł). Kontrakt techniczny spełniony w 100%: ID, `viewBox`, brak `<script>/<style>/class/@font-face`, kolory przez `var()` z fallbackiem, napisy na krzywych. Zweryfikowane wizualnie w 96/52/28 px, w trybie 2- i 4-kolorowym oraz w skali szarości. Figury oznaczone po polsku: **W / D / K**. |
| 2 — Stół | brak | Aplikacja rysuje sukno i krawędź CSS-em, więc działa. Brakuje `vulnerability.svg` (romb założeń) i `dealer-marker.svg` — dziś oddane tekstem. |
| 3 — Gracze | brak | Awatary robotów i graczy zastąpione inicjałem w kółku. |
| 4 — Licytacja | brak | Pastylki licytacyjne rysowane CSS-em; wyglądają dobrze, ale bez `contract-plate.svg`. |
| 5 — Ikony | brak | `icons.svg` (30 ikon) nieoddany. |
| 6 — Marka | **częściowo, prowizorycznie** | Brak `logo-full/logo-mark/empty-table`. `favicon.svg` i `favicon-mono.svg` **złożyłem tymczasowo z godeł z Pakietu 1** (2×2 na suknie, mosiężna ramka) — wcześniej `index.html` linkował nieistniejący plik i przeglądarka dostawała HTML zamiast ikony. Do podmiany, gdy przyjdzie prawdziwy sygnet. |
| 7 — Udostępnianie | brak | Bez `og-image.png` link do stołu nie ma podglądu w komunikatorach — to realna strata przy grze „wyślij link partnerowi". |

**Kolejność wg wpływu na produkt:** 7.1 (og-image — link wysyłany partnerowi), 6.1–6.3 (marka, w tym docelowy favicon), 5 (ikony), 2.3 (romb założeń — dziś tekst), 3 (awatary), 4.3, 2.1–2.2.
