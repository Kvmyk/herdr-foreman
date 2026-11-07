# Wideo na LinkedIn, GIF w README i estetyka narzędzi deweloperskich

Stan na 2026-11-07. Wytyczne techniczne i projektowe do redesignu materiałów (wideo demo, GIF, logo, banner) Kvmyk/herdr-foreman.

## 1. LinkedIn: wideo natywne i GIF-y

- **Format i kodek:** kontener MP4, wideo H.264, dźwięk AAC lub MPEG-4, zalecane 30 kl./s [1].
- **Proporcje i rozdzielczość:** 4:5 (od 360×450 do 1080×1350 px) i 1:1 (od 360×360 do 1080×1080 / 1920×1920 px) są optymalne w feedzie mobilnym (zajmują znacznie więcej ekranu niż 16:9). 16:9 (od 640×360 do 1920×1080 px) sprawdza się na desktopie, 9:16 (od 360×640 do 1080×1920 px) w pełnoekranowym feedzie pionowym [1].
- **Długość i rozmiar:** technicznie od 3 s do 30 min (reklamy do 500 MB, organicznie do 5 GB) [1], ale optymalny czas pod kątem uwagi to 30–60 s.
- **Autoodtwarzanie i napisy:** domyślnie wideo startuje w feedzie wyciszone. Pierwsze 2–3 sekundy wymagają mocnego wizualnego haczyka (hook). Zamiast liczyć na włączenie napisów z pliku SRT przez widza, kluczowe komunikaty i transkrypcję należy wtopić na stałe w klatki (open captions), a plik SRT dodać dla indeksowania [1].
- **Okładka (thumbnail):** plik JPG lub PNG do 2 MB, proporcje i rozdzielczość identyczne z plikiem wideo [1].
- **GIF w postach:** animowane GIF-y działają tylko jako pojedyncze, samodzielne grafiki w poście. W postach z wieloma grafikami i na profilu zamieniają się w statyczny obraz; na LinkedIn należy publikować natywne wideo MP4 [1].

## 2. Praktyka GIF w README GitHub

- **Ograniczenia i rozmiar:** GitHub narzuca limit 10 MB na obraz/GIF w markdownie [2]. W praktyce README powinien ładować się natychmiast – optymalna waga GIF-a to poniżej 3–5 MB.
- **Parametry:** szerokość 800–820 px (dopasowana do kolumny czytania), 12–15 kl./s (wystarcza do płynnego terminala, 2× mniejszy plik niż 30 fps).
- **Optymalizacja dwuprzebiegowa ffmpeg:** filtry `palettegen` (z `stats_mode=diff`) oraz `paletteuse` (z ditheringiem bayer) budują dedykowaną paletę 256 kolorów, eliminując artefakty i redukując wagę [3].
- **Narzędzia:** zamiast rysować fałszywe klatki w Pillow, używa się deklaratywnego Charm VHS (skrypty `.tape` kompilowane do powtarzalnego GIF/MP4) [4] lub asciinema (lekki, tekstowy zrzut sesji terminala) [5].

## 3. Objawy „AI slop” i tanich szablonów vs. co robią projektanci

- **Logo i ikony:**
  - *Objawy AI:* dosłowne ilustracje (kaski budowlane, koła zębate, mózgi), jaskrawe gradienty żółć-pomarańcz / cyjan-fiolet, świecące kulki, gwiazdki (sparkles ✨).
  - *Dobre praktyki:* surowa geometria wektorowa, czytelność w 16×16 px w jednym kolorze (monochrom), oszczędna siatka i dopracowana typografia (np. Linear, Raycast, Zed) [6].
- **Wideo i ruch (motion):**
  - *Objawy AI:* sztuczne terminale generowane skryptem z nienaturalnym easingiem, przesadne cienie, rozmycia szkła bez kontekstu, pływające karty.
  - *Dobre praktyki:* autentyczny zapis terminala z prawdziwym renderingiem ANSI (VHS) lub czysty zrzut ekranu z powiększeniem na kursor (Screen Studio) [4][7]. Szybki rytm, cięcia bez zbędnych animacji wejścia.
- **Dźwięk i muzyka:**
  - *Objawy AI:* generyczny korporacyjny podkład syntezatorowy 120 BPM w akordach Am–F–C–G (efekt muzyki ze stocka / generatora AI).
  - *Dobre praktyki:* brak muzyki lub minimalistyczny ambient/dron w tle, uzupełniony o foley mechanicznej klawiatury (kliknięcia switchy, uderzenie Enter) i subtelne efekty dźwiękowe interfejsu.

## Źródła

Wszystkie adresy sprawdzone 2026-11-07 (odrzucono 4 niedziałające źródła z błędami 404/403):
1. LinkedIn Video Ad Specs: https://business.linkedin.com/advertise/ads/sponsored-content/video-ads/specs
2. GitHub Attaching Files: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files
3. FFmpeg Filters (palettegen, paletteuse): https://ffmpeg.org/ffmpeg-filters.html
4. Charm VHS: https://github.com/charmbracelet/vhs
5. asciinema: https://asciinema.org
6. Linear Method: https://linear.app/method
7. Screen Studio: https://screen.studio
