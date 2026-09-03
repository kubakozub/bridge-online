# Mega prompt dla Claude Design — komplet grafiki do „Bridge Online” (wersja jasna)

> **Jak używać:** skopiuj wszystko poniżej linii `--- POCZĄTEK PROMPTU ---` i wklej do Claude
> Design jako jedną wiadomość. Prompt jest samowystarczalny — zawiera brief, punkt odniesienia,
> kierunek artystyczny, tokeny kolorów zgodne z kodem, pełny manifest zasobów i **kontrakt
> integracyjny** (ID symboli, `viewBox`, nazwy zmiennych CSS). Dzięki temu wynik wchodzi do
> repozytorium bez przerabiania kodu.
>
> Chcesz podzielić pracę na mniejsze zlecenia? Każdy „PAKIET n” jest samodzielny — wklej wtedy
> **Sekcje 1–5** plus wybrany pakiet.
>
> Gra działa na żywo pod [brydz.uk](https://brydz.uk) — designer może ją otworzyć i zobaczyć, co
> dokładnie zastępuje.

---

--- POCZĄTEK PROMPTU ---

Jesteś dyrektorem artystycznym i ilustratorem. Zaprojektuj **komplet oryginalnej grafiki
wektorowej** dla działającej aplikacji **Bridge Online** — brydża dla dwóch osób grających
zdalnie (gra na żywo: brydz.uk). Poniżej masz kontekst, punkt odniesienia, sztywne ograniczenia
techniczne i manifest zasobów. Trzymaj się ich dosłownie: grafika ma wejść do istniejącego kodu
bez zmian w kodzie.

## SEKCJA 1 — Brief produktowy

**Co to jest.** Przeglądarkowa gra w brydża sportowego. Dwie osoby w dwóch różnych miastach
wchodzą na ten sam link, siadają przy wirtualnym stole, a wolne krzesła obsadzają roboty.
Rozgrywa się licytację (pudełko odzywek 7×5), a potem 13 lew. Wynik liczony punktacją turniejową.

**Kto gra.** Dwie grupy naraz:
- Osoby 50–70 lat, znające brydża z klubu i ze stołu fizycznego. Grają na laptopie lub tablecie,
  często w okularach. **Czytelność jest ważniejsza niż efekt.**
- Osoby 25–40 lat uczące się brydża, grające na telefonie w pionie (360–430 px szerokości).

**Ekran, który projektujesz.** Stół wypełnia całe okno i **nie przewija się** — cztery ręce, pole
lewy i własne karty muszą być widoczne naraz. To ostry budżet miejsca: każdy piksel wydany na
ozdobnik jest zabrany kartom.

## SEKCJA 2 — Punkt odniesienia i czym mamy go pobić

Punktem odniesienia jest **247bridge.com**. Zamawiający lubi tę stronę: jest jasna, czytelna od
pierwszej sekundy, przyjazna i nie wymaga nauki interfejsu. **To zachowujemy.**

**Nie kopiuj niczego z tamtego serwisu** — ani logo, ani układu, ani rysunku kart, ani
kolorystyki marki. Punkt odniesienia to poziom *odczucia*, nie materiał źródłowy. Wszystko, co
oddasz, ma być oryginalne.

Przewaga, którą masz zbudować — pięć konkretów, każdy sprawdzalny:

1. **Rysunek kart zamiast skalowanej bitmapy.** Karty mają być czystym wektorem, ostrym przy
   każdej wielkości, z prawdziwym układem oczek i figurami rysowanymi, a nie literą w ramce.
2. **Talia czterokolorowa jako równorzędna opcja.** Mylenie kierów z karami to najczęstszy błąd
   w brydżu online. Obie wersje mają wyglądać na zaprojektowane, nie na wariant awaryjny.
3. **Hierarchia zamiast jednolitego tła.** Sukno, pole lewy i strefa własnej ręki mają się od
   siebie odróżniać wartością tonalną, żeby wzrok wiedział, gdzie patrzeć — bez linii i ramek.
4. **Stany, nie tylko kształty.** Karta legalna, nielegalna, wskazana kursorem i właśnie zagrana
   to cztery różne rzeczy. Zaprojektuj je świadomie (Pakiet 5).
5. **Spokojna typografia.** Bez konturów, cieni rzucanych pod literami i efektu „chrom”. Wartości
   kart czytelne przy 28 px wysokości karty.

**Emocja docelowa.** Jasny pokój w słoneczny dzień, świeże sukno, czysty stół, dobre światło.
Przyjaźnie i pogodnie, ale bez infantylności. Zero hazardu, zero żetonów, zero neonów, zero
cartoonowych maskotek.

## SEKCJA 3 — Kierunek artystyczny

**Rób tak:**
- Jasna, wysokokontrastowa paleta — patrz Sekcja 4. Motyw jasny jest teraz **domyślny**.
- Płaski wektor z **jednym** miękkim światłem z góry. Cienie delikatne i krótkie: na jasnym tle
  ciężki cień natychmiast robi się brudny.
- Formy geometryczne, precyzyjne, spójne grubości linii (2 px i 2.5 px w układzie 240×336).
- Krawędzie kart muszą działać na jasnym tle: białej karty na jasnym suknie nie wydzieli cień —
  potrzebna jest cienka, wyraźna krawędź o wartości ciemniejszej od sukna.
- Wszystko czytelne przy **28 px wysokości karty** (karta na telefonie w bocznej ręce). Testuj
  każdy zasób zmniejszony do 15%, zanim uznasz go za skończony.

**Nie rób tak:**
- Bez gradientów tęczowych, blasku, skosów, faz 3D, fotograficznych tekstur drewna, efektu szkła.
- Bez cieni pod wieloma kątami — jedno światło, jeden kierunek.
- Bez linii cieńszych niż 1.5 px w układzie 240×336 (znikną na telefonie).
- Bez tekstu w grafice poza wartościami kart (2–10, W, D, K, A) i logotypem.
- Bez naśladowania jakiejkolwiek istniejącej marki kart lub serwisu brydżowego.

## SEKCJA 4 — Tokeny kolorów (skopiuj wartości dokładnie)

Motyw **jasny „daylight” — domyślny**:

```
--felt-1        #eef1ec   tło strony (pokój wokół stołu)
--felt-2        #34926b   blat stołu, zielone sukno
--felt-3        #3da878   pole lewy, sukno rozjaśnione
--felt-rail     #b07f4f   drewniana krawędź stołu (jasny dąb)
--felt-rail-hi  #c99a68   rozjaśnienie krawędzi od strony światła

--surface-1     #ffffff   panele
--surface-2     #f5f7f4
--surface-3     #e8ece7

--text-1        #16211d   tekst główny
--text-2        #46554f   tekst drugorzędny
--text-3        #78877f   tekst wyłączony

--accent        #b8801a   mosiądz — kolor akcji
--info          #2f7fb5
--success       #2f8f5b
--warning       #c9822a
--danger        #c0392f

--card-face     #ffffff   awers karty
--card-edge     rgba(16,32,28,.32)   krawędź karty — MUSI odcinać biel od sukna
--card-back     #1d5f86   rewers karty
--card-back-ink rgba(255,255,255,.62)

--suit-spade    #16161d
--suit-heart    #c8102e
--suit-diamond  #c8102e   (w talii czterokolorowej #1c62c4)
--suit-club     #16161d   (w talii czterokolorowej #157a45)
```

Motyw **ciemny „felt”** zostaje jako opcja wieczorna: sukno `#12382c`, tło `#0d2b22`, tekst
`#f2f6f3`, akcent `#f0c05a`. Zasoby mają działać w obu — osiągasz to używając zmiennych, a nie
projektując dwóch wersji.

**Typografia w kodzie:** UI = Inter (400/500/600/700). Nagłówki i wartości kart = Source Serif 4
(600/700). Jeśli w grafice potrzebujesz liter, **zamień je na krzywe** — pliki nie mogą zależeć od
fontu zainstalowanego u gracza.

## SEKCJA 5 — Kontrakt techniczny (naruszenie = grafika nie wejdzie do kodu)

1. **Format: SVG.** Bez PNG, bez JPG, bez rastrów osadzonych w SVG. Wyjątek: obraz OG (Pakiet 7)
   — tam PNG 1200×630.
2. **Karty i godła oddajesz jako jeden sprite** — plik `sprite.svg` o strukturze:
   ```xml
   <svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
     <symbol id="card-SA" viewBox="0 0 240 336"> ... </symbol>
     <symbol id="card-HT" viewBox="0 0 240 336"> ... </symbol>
     ...
     <symbol id="card-back" viewBox="0 0 240 336"> ... </symbol>
     <symbol id="suit-S" viewBox="0 0 100 100"> ... </symbol>
     <symbol id="suit-S-mono" viewBox="0 0 100 100"> ... </symbol>
   </svg>
   ```
3. **Identyfikatory są sztywne.** `card-` + litera koloru + znak wartości:
   - kolory: `S` pik, `H` kier, `D` karo, `C` trefl
   - wartości: `2 3 4 5 6 7 8 9 T J Q K A` (`T` = dziesiątka, `J` = walet, `Q` = dama, `K` = król)
   - czyli 52 symbole: `card-S2` … `card-SA`, `card-H2` … `card-CA`
   - dodatkowo `card-back` oraz `suit-S`/`suit-H`/`suit-D`/`suit-C` i warianty `suit-*-mono`
     (mono = wypełnienie `currentColor`, do przycisków i tabeli licytacji)
4. **`viewBox` kart to dokładnie `0 0 240 336`** (proporcja 2.5 : 3.5). Rewers ten sam. Godła
   kolorów: `0 0 100 100`, wyśrodkowane, wypełniające ~92% pola.
5. **Kolory tylko przez zmienne CSS z literalnym fallbackiem**, np.
   `fill="var(--suit-heart, #c8102e)"`, `fill="var(--card-face, #ffffff)"`. Sprite jest wklejany
   do DOM, więc zmienne ze strony zadziałają.
6. **Zero `<style>`, `<script>`, `class` i `id` wewnątrz symboli** (poza `id` samego `<symbol>`).
   Atrybuty prezentacji wpisujesz bezpośrednio w elementy.
7. **Zero odwołań zewnętrznych** — żadnych `<image href="http...">`, żadnych `@font-face`.
8. Ścieżki zoptymalizowane (współrzędne do 2 miejsc po przecinku). Cel: **sprite ≤ 180 KB** przed
   kompresją.
9. Każdy zasób spoza sprite'a oddajesz jako osobny plik SVG o nazwie z manifestu, z `viewBox`
   podanym w manifeście i **bez** sztywnych `width`/`height`.

Referencja: obecny, generowany proceduralnie sprite leży w repo pod `public/cards/sprite.svg`, a
strona podglądu pod `/dev/cards.html`. Twoja wersja ma go zastąpić 1:1 — te same ID, ten sam
`viewBox`, wyższa jakość rysunku.

---

## PAKIET 1 — Talia (najważniejszy, zrób go najpierw)

**1.1 Blotki 2–10, cztery kolory = 36 kart.** Klasyczny układ oczek w siatce 3 kolumn × 7 rzędów.
Dolna połowa oczek obrócona o 180°, jak na prawdziwej talii. Indeks w dwóch przeciwległych
narożnikach: wartość + małe godło. Indeks musi być czytelny, gdy widać tylko 22 px lewej krawędzi
karty — tak leżą karty w rozwiniętym wachlarzu.

**1.2 Figury W, D, K — 12 kart.** To miejsce, w którym wygrywamy z punktem odniesienia. Sylwetki
heraldyczne, symetryczne względem środka karty (górna połowa odbita w dolnej), w cienkiej ramce.
Walet = pióropusz, dama = diadem z trzema kamieniami, król = korona z pięcioma zębami. Każdy kolor
dostaje **inny detal wypełnienia**, żeby figury nie zlewały się w skali — ale ta sama sylwetka
bazowa. Ma to wyglądać na rysowane, nie na literę w prostokącie.

**1.3 Asy — 4 karty.** Duże, ozdobne godło na środku (≈120 px w układzie 240×336). As pik dostaje
najbogatszą oprawę (tradycja), pozostałe skromniejszą.

**1.4 Rewers `card-back`.** Wzór giloszowy: regularna, drobna plecionka w `--card-back-ink` na tle
`--card-back`, z podwójną ramką i centralną rozetą z czterema godłami. Wzór bezszwowy w obrębie
karty i **bez mory przy zmniejszeniu do 30 px**. Trzy warianty kolorystyczne: `card-back`,
`card-back-crimson`, `card-back-forest`.

**1.5 Godła kolorów** — `suit-S/H/D/C` + warianty `-mono`. Cztery klasyczne kształty wyważone
optycznie: przy tej samej wysokości mają wyglądać na tak samo „ciężkie”.

## PAKIET 2 — Stół (kluczowy dla wrażenia „jaśniej”)

**2.1 `table-felt.svg`** (`viewBox="0 0 1600 1000"`) — blat: zaokrąglony prostokąt sukna
`--felt-2` z delikatnym rozświetleniem radialnym u góry, otoczony jasną drewnianą krawędzią
`--felt-rail` z rozjaśnieniem `--felt-rail-hi` od strony światła. Tekstura sukna jako bardzo
subtelny szum wektorowy (kreski o `opacity` ≤ 0.05), nie bitmapa.

**2.2 `trick-well.svg`** (`viewBox="0 0 400 400"`) — wgłębienie na środku, gdzie lądują cztery
karty lewy. Na jasnym suknie to ma być **rozjaśnienie** (`--felt-3`), nie przyciemnienie —
inaczej środek stołu zrobi się brudną plamą.

**2.3 `vulnerability.svg`** (`viewBox="0 0 100 100"`) — klasyczny romb podzielony na cztery
ćwiartki (N, E, S, W). Ćwiartka strony „po partii” czerwona `--danger`, „przed partią” zielona.
Cztery warianty: `vul-none`, `vul-ns`, `vul-ew`, `vul-both`.

**2.4 `dealer-marker.svg`** (`viewBox="0 0 100 100"`) — okrągły mosiężny żeton z literą „R”
(rozdający), litera na krzywych.

## PAKIET 3 — Gracze przy stole

**3.1 Awatary robotów — 3 sztuki**: `robot-beginner.svg`, `robot-intermediate.svg`,
`robot-advanced.svg`, `viewBox="0 0 120 120"`. Geometryczne, spokojne „głowy” w kole. Poziom
sygnalizowany liczbą elementów i kolorem obwódki, **nie** gwiazdkami i nie mimiką. Mają wyglądać
na partnera do brydża, nie na zabawkę.

**3.2 Awatary graczy — 8 abstrakcyjnych** `avatar-01.svg` … `avatar-08.svg`
(`viewBox="0 0 120 120"`). Godła w kole: kotwica, liść, kompas, klepsydra, klucz, pióro, latarnia,
żagiel. Jednokolorowe na `--surface-3`.

**3.3 `seat-ring.svg`** (`viewBox="0 0 200 200"`) — pierścień podświetlający krzesło gracza, na
którym jest kolej. Przerwa u dołu na łuk odliczania czasu (łuk rysuje kod).

**3.4 `connection-dot.svg`** — trzy stany jako trzy symbole: `conn-online`, `conn-away`,
`conn-offline`.

## PAKIET 4 — Licytacja

**4.1 Pastylki licytacyjne.** Nie rysuj 35 plików — oddaj **jeden szablon** `bid-chip.svg`
(`viewBox="0 0 120 84"`): zaokrąglony prostokąt z miejscem na cyfrę poziomu po lewej i godło po
prawej, plus warianty stanu jako osobne symbole: `bid-chip`, `bid-chip-disabled`, `bid-chip-hint`.
Uwaga: na jasnym tle pastylka nielegalna nie może po prostu zblednąć — musi mieć **inny kształt
sygnału** (np. przekreślenie), bo sama jasność zginie.

**4.2 Trzy przyciski specjalne** (`viewBox="0 0 160 84"`): `call-pass` (PAS, zielony),
`call-double` (KONTRA — duże „X”, czerwony), `call-redouble` (REKONTRA — „XX”, niebieski). Litery
na krzywych.

**4.3 `contract-plate.svg`** (`viewBox="0 0 240 90"`) — mosiężna tabliczka, na której kod wypisuje
zawarty kontrakt. Sama tabliczka, bez tekstu.

## PAKIET 5 — Stany karty (tego nie ma punkt odniesienia)

Oddaj jako `card-states.svg` — cztery symbole nakładane na kartę, `viewBox="0 0 240 336"`:

- `state-legal` — subtelne podniesienie: krótki cień pod dolną krawędzią, nic więcej.
- `state-illegal` — wygaszenie czytelne także w skali szarości (nie sam spadek jasności).
- `state-hover` — obrys w `--accent`, grubość 3 px, zaokrąglony jak karta.
- `state-just-played` — jednorazowy błysk krawędzi, do animacji lądowania karty w lewie.

Dodatkowo krótki opis (2–3 zdania), jak te stany mają się zachować w ruchu — kod dopisze
animacje sam.

## PAKIET 6 — Ikony interfejsu

Jeden plik `icons.svg` ze sprite'em, `viewBox="0 0 24 24"`, linia 1.75 px, zaokrąglone końce,
wypełnienie `currentColor`, ID zgodne z listą:

`icon-copy`, `icon-check`, `icon-share`, `icon-settings`, `icon-chat`, `icon-score`, `icon-undo`,
`icon-claim`, `icon-leave`, `icon-sit`, `icon-robot`, `icon-sound-on`, `icon-sound-off`,
`icon-theme-dark`, `icon-theme-light`, `icon-deck-two`, `icon-deck-four`, `icon-help`,
`icon-close`, `icon-chevron`, `icon-clock`, `icon-wifi`, `icon-wifi-off`, `icon-crown`
(rozgrywający), `icon-eye` (dziadek), `icon-next-board`, `icon-history`, `icon-hcp`, `icon-menu`,
`icon-link`.

## PAKIET 7 — Marka i udostępnianie

**7.1 `logo-full.svg`** (`viewBox="0 0 480 120"`) — sygnet + logotyp „Bridge Online”. Sygnet:
cztery godła ułożone w formę mostu / łuku — most to dosłowna i trafna metafora (bridge + dwoje
ludzi w dwóch miejscach połączonych łukiem). Logotyp z Source Serif 4 zamienionego na krzywe.

**7.2 `logo-mark.svg`** (`viewBox="0 0 120 120"`) — sam sygnet.

**7.3 `favicon.svg`** (`viewBox="0 0 32 32"`) — maksymalne uproszczenie sygnetu, rozpoznawalne
przy 16 px. Dodatkowo `favicon-mono.svg` na jednolitym tle.

**7.4 `empty-table.svg`** (`viewBox="0 0 400 300"`) — pusty stan „Czekamy na drugiego gracza”: dwa
krzesła po przeciwnych stronach stołu, jedno puste. Spokojna, jednobarwna, bez tekstu.

**7.5 `og-image.png`** — 1200×630 PNG, jedyny raster w zestawie. Jasne sukno, sygnet, hasło
„Brydż online dla dwojga” i wachlarz czterech kart.

## SEKCJA 6 — Jak oddajesz pracę

1. Zacznij od **Pakietu 1**. Pokaż arkusz kontrolny: wszystkie 52 karty w siatce w trzech skalach
   — 96 px, 52 px i 28 px wysokości — na tle `--felt-2`. Dopiero po akceptacji rób resztę.
2. Dla każdego pakietu podaj listę plików, ID symboli, `viewBox` i rozmiar po optymalizacji.
3. Na koniec oddaj arkusz przeglądowy `docs/design-sheet.svg` z całym zestawem.

## SEKCJA 7 — Kryteria akceptacji (sprawdź sam przed oddaniem)

- [ ] 52 karty + rewers + 8 godeł mają **dokładnie** ID i `viewBox` z Sekcji 5.
- [ ] Każdy kolor pochodzi ze zmiennej CSS z fallbackiem; przełączenie na talię czterokolorową
      zmienia wyłącznie karo i trefl.
- [ ] Wartość i kolor karty da się odczytać z samego narożnika przy 28 px wysokości karty.
- [ ] Biała karta odcina się od jasnego sukna **bez** polegania na cieniu.
- [ ] Kier i karo są rozróżnialne w skali szarości (usuń kolor — kształty muszą wystarczyć).
- [ ] Pastylka nielegalnej odzywki jest rozpoznawalna w skali szarości.
- [ ] Sprite ≤ 180 KB, bez `<script>`, `<style>`, `class`, `@font-face` i odwołań zewnętrznych.
- [ ] Wszystkie napisy zamienione na krzywe.
- [ ] Zestaw działa w motywie jasnym i ciemnym.
- [ ] Nic nie przypomina logo ani stylistyki istniejącego serwisu brydżowego czy wydawcy kart.

--- KONIEC PROMPTU ---

---

## Jak wgrać wynik do repozytorium

1. Podmień `public/cards/sprite.svg` na plik z Pakietu 1.
2. Przegeneruj wersję wbudowaną w bundle:
   ```bash
   node scripts/embed-sprite.mjs
   ```
   Skrypt **sprawdza kontrakt** (52 symbole o właściwych ID, `viewBox` `0 0 240 336`, brak
   skryptów i odwołań zewnętrznych) i odmawia wbudowania grafiki, która go łamie. Powrót do talii
   proceduralnej: `npm run cards`.
3. Pozostałe pliki wrzuć do `public/art/`, ikony do `public/art/icons.svg`.
4. Sprawdź wizualnie pod `/dev/cards.html`, potem zagraj jedno rozdanie.

## Zmiana motywu domyślnego na jasny

Prompt zakłada, że jasny motyw jest domyślny. Po stronie kodu to dwie rzeczy:

- w `src/client/styles/tokens.css` podmienić wartości bloku `[data-theme='daylight']` na paletę
  z Sekcji 4 i przenieść ją do `:root`,
- w `src/client/net/identity.ts` ustawić `daylight` jako domyślną preferencję nowego gracza.
