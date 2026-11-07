# herdr-foreman: specyfikacja

Stan na 2026-11-07, druga sesja. Przebieg, uprawnienia, wynik pracy i dobór agentów są ustalone z Kubą. Decyzje techniczne (sekcja „Decyzje techniczne”) to propozycje Claude przyjęte przez polecenie „rozpocznij implementację”, bez osobnego omawiania. Nazwa jest robocza.

## Po co

Rozdzielanie pracy między kilku agentów w herdr jest dziś ręczne: trzeba samemu wymyślić podział, otworzyć panele, wybrać agentów, rozesłać zadania i potem wszystko zebrać. Cel: wpisujesz w terminalu zadanie zwykłymi słowami, a resztę robi agent-lider. Najpierw na własny użytek Kuby, potem publikacja na GitHubie (marketplace pluginów herdr, lista awesome-herdr).

Główne zastosowanie: **rozwijanie i utrzymanie oprogramowania**. Typowe zadania (od Kuby): testowanie aplikacji (sprawdzanie i szukanie błędów), sprawdzanie luk w bezpieczeństwie, tworzenie oprogramowania, analiza działania aplikacji.

## Cele, nie-cele, anty-cele

- **Cele:** jedno polecenie w terminalu; lider sam wybiera liczbę i rodzaj agentów spośród zainstalowanych i działających; dobór według mocnych stron, który z czasem się uczy i nie starzeje; zawsze widać, co się zmieni, zanim ktoś ruszy kod; wszystko zostaje lokalnie.
- **Nie-cele (na teraz):** push, PR, praca w chmurze, automatyczne zatwierdzanie PR-ów z aktualizacją wiedzy (później), sterowanie z telefonu.
- **Anty-cele:** workerzy zmieniający kod bez zgody użytkownika; ciche wyczerpanie limitów subskrypcji; tabela mocnych stron, która po miesiącu jest nieaktualna; wymóg ręcznej konfiguracji każdego agenta przed pierwszym użyciem.

## Przebieg (ustalony)

1. W katalogu repo, w zwykłym terminalu: `foreman "sprawdź bezpieczeństwo modułu płatności i popraw, co trzeba"`. Komenda działa też z panelu herdr. Ze zwykłego terminala sama uruchamia serwer herdr, jeśli nie działa, tworzy przestrzeń roboczą z tym katalogiem, startuje lidera i otwiera herdr. Z panelu herdr startuje lidera w nowej karcie bieżącej przestrzeni roboczej.
2. Lider czyta repo i sprawdza, którzy agenci są zainstalowani, zalogowani i na jakich modelach działają (inwentarz, niżej).
3. Lider dzieli zadanie na części, ustala liczbę workerów i dobiera agenta do każdej części. Plan pokazuje tylko do wglądu, bez czekania na zgodę, bo ten etap niczego nie zmienia w kodzie. To propozycja Claude: szkic z pierwszej sesji zakładał zgodę na starcie.
4. Każdy worker bada swoją część **bez zmieniania czegokolwiek** i oddaje liderowi krótką listę: co jest nie tak, gdzie, co chce zmienić. Przy nowych funkcjach to opis, jak zrobi swoją część.
5. Lider usuwa powtórzenia i pokazuje użytkownikowi jedną ponumerowaną listę z wagą i autorem:
   ```
   1. [wysokie] api/auth.ts: token bez daty ważności -> dodać exp i sprawdzanie   (claude1)
   2. [średnie] /login bez limitu prób -> rate limit                             (gemini1)
   ```
   Użytkownik odpowiada np. „1 i 3 tak, 2 nie”. **Zlecenia workerom wydaje tylko lider.**
6. Lider zleca zatwierdzone zmiany, domyślnie workerowi, który znalazł problem (ma kontekst). Każdy worker zmieniający kod pracuje w osobnym worktree git na lokalnej gałęzi.
7. Lider zbiera zmiany w jedną lokalną gałąź `foreman/<krótka-nazwa-zadania>`, sprawdza, czy projekt się buduje i czy testy przechodzą, i przegląda wynik.
8. Lider pokazuje podsumowanie (co zmieniono, w których plikach, wynik testów) i pyta, czy wszystko jest w porządku. Użytkownik wybiera:
   - `scal`: lider scala gałąź do bieżącej; jeśli są niezapisane zmiany, najpierw pyta;
   - `zostaw`: gałąź zostaje, lider podaje komendę do scalenia i sprząta worktree;
   - uwagi własnymi słowami: lider zleca poprawki i wraca z tym samym pytaniem.
9. Nic nie wychodzi poza komputer: bez push i bez PR.

## Pytania workerów o zgodę (ustalone)

Jeśli któryś worker zatrzyma się na pytaniu o zgodę (stan `blocked`), lider pyta użytkownika, czy odpowiada sam, czy lider ma akceptować za niego. Jeśli lider, to akceptuje na odpowiedzialność użytkownika.

Propozycje Claude:

- Lider pyta raz, przy pierwszym takim pytaniu, a wybór obowiązuje do końca zadania.
- Jeśli użytkownik odpowiada sam, lider mówi, który panel czeka i o co pyta.
- Nawet gdy lider akceptuje, zawsze odmawia push i PR, a o rzeczy wyraźnie spoza zadania (usuwanie plików poza worktree, globalna instalacja pakietów) pyta użytkownika.
- Odpowiedź wysyła przez `herdr agent read` (odczyt ekranu) i `herdr agent send-keys`.

## Dobór agentów (ustalone, szczegóły w research)

Research: `docs/research/2026-11-07-dobor-agentow.md`. Najważniejsze: o wyniku decyduje trójka program + model + dostęp, a nie sam rodzaj agenta. Żaden model nie wygrywa we wszystkim. Rankingi się starzeją. Najlepiej działa dobór z pamięcią wcześniejszych wyników.

Trzy warstwy wiedzy, które lider dostaje przy planowaniu:

1. **Inwentarz** (przy każdym starcie): dla każdego rodzaju z listy herdr, którego program jest w PATH, zbierane są wersja, stan logowania, dostępne modele i model domyślny, tryby uprawnień, rodzaj dostępu (lokalny, subskrypcja, API). Agent bez działającego dostępu wypada z puli, a użytkownik dostaje jedno zdanie, dlaczego.
2. **Wiedza ogólna:** cechy programów (plik w pluginie) i cechy modeli (models.dev automatycznie oraz krótka lista tendencji rodzin modeli z datą i źródłem). Wszystko nadpisywalne w konfiguracji użytkownika. Wpis starszy niż ~90 dni lider traktuje jako niepewny.
3. **Dziennik wyników** u użytkownika. Po każdym zadaniu lider zapisuje dla każdego workera kategorię części, program, model, zatwierdzone i odrzucone propozycje, wynik testów i przeglądu, liczbę poprawek oraz to, czy utknął. Przy planowaniu lider dostaje statystyki per kategoria. Póki w kategorii jest mniej niż ~5 wyników, decyduje wiedza ogólna; potem przeważa dziennik, z małą szansą na próbę innego agenta.

Kategorie części: analiza działania, audyt bezpieczeństwa, testowanie i szukanie błędów, naprawa błędu, nowa funkcja, refaktoryzacja, pisanie testów, dokumentacja.

Reguły stałe:

- Przy przeglądzie i bezpieczeństwie ten sam obszar dostają dwie różne rodziny modeli (różne programy z tym samym modelem się nie liczą).
- Limity subskrypcji traktowane są jako budżet.
- Modele lokalne dostają tylko proste zadania.

## Aktualność wiedzy (ustalone: droga A)

Raz w tygodniu zaplanowany agent (rutyna w chmurze albo GitHub Action w repo pluginu):

1. pobiera dane z models.dev i aktualnych rankingów;
2. robi research nowych modeli i szuka nowych źródeł, bo stare umierają (ranking Aidera stoi od 10.2025, dotychczasowe API Artificial Analysis zwraca 410);
3. aktualizuje plik wiedzy ze źródłami i datami;
4. otwiera PR.

Kuba zatwierdza PR; później można to zautomatyzować. Foreman przy starcie pobiera aktualny plik wiedzy z repo, najwyżej raz dziennie, z kopią lokalną na wypadek braku sieci. Model, o którym nikt nic nie wie, dostaje oznaczenie „nowy, niesprawdzony” i na początek mniejsze części pracy.

## Decyzje techniczne (propozycje Claude)

- **Architektura C (hybryda):** program dostarcza mechanikę jako komendy, a model-lider podejmuje decyzje i woła te komendy.
  - Mechanika: inwentarz, panele i worktree, start i czekanie na workerów, zbieranie wyników, dziennik.
  - Decyzje: podział, przydział, łączenie list, przegląd, scalanie.
  - Uzasadnienie: przebieg ma kroki wymagające osądu (podział, przegląd, odpowiadanie na pytania o zgodę) i kroki mechaniczne, które muszą być powtarzalne i testowalne.
- **Język: Node.js ≥ 20, czysty JavaScript (ESM), bez zależności i bez kroku budowania.**
  - Działa tak samo na Windows, macOS i Linuksie, a Kuba pracuje na Windowsie.
  - Node jest prawie zawsze obecny u użytkowników agentów, bo większość z nich instaluje się przez npm.
  - Testy na `node:test`.
  - Logika układu paneli przeniesiona z `C:\Users\Kuba\.claude\skills\agenci\agenci.ps1`.
- **Lider domyślnie:** `claude`, zmienialny w konfiguracji.
- **Lider tylko koordynuje,** nie wykonuje części pracy. To propozycja: wynika z zasady „lider wypisuje, im zleca”.
- **Instrukcja dla lidera** to plik Markdown w pluginie, przekazywany liderowi przy starcie. Nie zależy od mechanizmu skilli konkretnego agenta, więc działa dla każdego rodzaju lidera.
- **Stan i dziennik:** katalog `~/.herdr-foreman/` (konfiguracja, dziennik JSONL, kopia pliku wiedzy).
- **Plugin herdr** (manifest TOML, akcja pod klawiszem „opisz zadanie”) w późniejszym etapie. Najpierw samodzielna komenda `foreman`.
- **Workerzy startują od razu we własnych worktree,** także w fazie badania. Zakaz zmian w tej fazie wynika z instrukcji, a lider sprawdza go po fazie badania (czysty worktree, zero commitów). Worker poprawiający problem zachowuje wtedy kontekst, a okno zaufania do folderu pojawia się tylko raz.
- **Lokalizacje:**
  - worktree poza repo: `~/.herdr-foreman/worktrees/<repo>-<hash>/<task>/<worker>`, gałęzie `foreman-work/<task>/<worker>` (git nie pozwala mieć naraz `foreman/<task>` i `foreman/<task>/<worker>`);
  - zmiany zbierane w osobnym worktree `_merge` na gałęzi `foreman/<task>`, więc gałąź i katalog użytkownika są nietknięte aż do `scal`;
  - raporty workerów w `~/.herdr-foreman/runs/<task>/<worker>/`.
- **Wyjście CLI po angielsku** (publikacja). Lider rozmawia z użytkownikiem w języku zadania.
- **Plan implementacji:** `docs/plans/2026-11-07-foreman-mvp.md`.
- **Zabezpieczenia startu** (wyszły w trakcie budowy): foreman odmawia, gdy repozytorium to katalog domowy (u Kuby `C:\Users\Kuba` jest repozytorium git bez commitów), i gdy repo nie ma jeszcze commitów.
- **Sprzątanie w Windows:** po zamknięciu paneli proces agenta trzyma folder jeszcze kilka sekund, więc `cleanup` czeka, ponawia próbę, a w ostateczności usuwa folder i robi `git worktree prune`.
- **Okno zaufania Claude Code** ma domyślnie zaznaczone „No, exit”; lider wybiera „Yes” klawiszami `down`, `enter`.

## Co już istnieje (przegląd 2026-11-07)

herdr 0.9.5 (najnowszy, 2026-10-14) nie ma wbudowanej orkiestracji, tylko klocki (panele, `agent start/prompt/wait/read/send-keys`). Tematem `herdr-plugin` oznaczono ponad 2000 repozytoriów, w tym kilkadziesiąt orkiestratorów. Najbliższe pomysłowi:

| Projekt | Co ma | Czego brakuje względem foremana |
|---|---|---|
| [herdr-hive](https://github.com/pparitoshh/herdr-hive) (0★, od 2026-11-06) | lider i N workerów w worktree, szyna wiadomości, lokalny router wybierający poziom trudności (fast/regular/think), dziennik decyzji, ekran przeglądu, scal/popraw/odrzuć | programy i modele poziomów ustawia użytkownik; brak wykrywania dostępu i modeli, mocnych stron per kategoria, aktualizacji wiedzy, przebiegu „propozycje i zgoda”; Python i gniazdo uniksowe |
| [AgentCompass](https://github.com/akiiwa-games/AgentCompass) (4★, od 2026-10-27) | dobór model × wysiłek według mocnych stron i bieżących limitów 5h/7d, wykrywanie zalogowanych kont, dane publiczne z repo co 6 h (kalibracja z LMArena, vals.ai, Artificial Analysis), Windows | to router wołany przez inną sesję, bez przebiegu w panelach herdr (plan, propozycje, zgoda, scalanie); bardzo rozbudowany (zasobnik, usługi), jeden autor |
| [ralfkuh-lab/herdr-orchestrator](https://github.com/ralfkuh-lab/herdr-orchestrator) | skill: delegowanie do 9 rodzajów agentów w widocznych panelach, odpowiadanie na pytania o zgodę po treści opcji, odczyt limitów | wybór agenta opisuje użytkownik w `policy.md` |
| [oldwinter/herdr-orchestrator](https://github.com/oldwinter/herdr-orchestrator) | katalog programów z polami strengths / best_for / avoid_for, deterministyczny koordynator z kolejką | katalog statyczny, ręczny |
| [squad-devkit](https://github.com/bthanhtung/squad-devkit) | lider i workerzy w worktree, wykrywa zainstalowane silniki | wybór workerów bez mocnych stron per kategoria |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (70k★) | kategorie zadań przypisane do modeli, utrzymywane przez autorów | własny program (omo), nie orkiestracja w herdr |

Wyróżnik foremana to połączenie, którego nikt nie ma w całości: jedna komenda; wykrywanie programu, modelu i dostępu; liczba agentów zależna od zadania; dobór według mocnych stron z uczeniem na wynikach użytkownika i cotygodniowo aktualizowaną wiedzą; przebieg „propozycje, zgoda, poprawki”. Ryzyko: rynek jest zatłoczony i szybki, a AgentCompass albo herdr-hive mogą dobudować brakujące części.

Starsze projekty z pierwszego przeglądu: crew, herdr-claude-teams, herdr-swarm, herdr-fleet, herdr-orchestra, oh-my-herdr (stałe role albo wybór przez użytkownika).

## Fakty o herdr (sprawdzone na v0.9.5)

- Plugin to manifest TOML plus dowolny program. Ma akcje pod klawiszami (`[[keys.command]]` z `plugin_action`), panele `overlay`, `popup`, `split`, `tab`, `zoomed` i hooki. Dostaje `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_PLUGIN_CONTEXT_JSON`. Instalacja: `herdr plugin install owner/repo[/subdir]`, lokalnie `herdr plugin link <ścieżka>`. Marketplace indeksuje publiczne repo z tematem `herdr-plugin`. Dokumentacja: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/plugins.mdx
- Na Windowsie komendy z `[[keys.command]]` idą przez `cmd.exe /d /c`.
- `herdr agent start <nazwa> --kind <rodzaj> --pane <id> [--timeout MS] [-- <argumenty agenta>]` wymaga panelu z powłoką przy znaku zachęty i wraca, gdy agent jest gotowy, albo z `agent_not_ready`. Nazwy: `[a-z][a-z0-9_-]{0,31}`.
- `herdr agent prompt <cel> "<tekst>" --wait`, `herdr agent wait`, `herdr agent read --source recent-unwrapped --lines N`, `herdr agent send-keys`, stany `idle`, `working`, `blocked`, `done`, `unknown`.
- Rodzaje agentów: pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode, opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, qwen, letta, maki, muse.
- `herdr pane split --pane <id> --direction right|down --ratio <r> --cwd <ścieżka> --no-focus`; `ratio` to część, która zostaje w dzielonym panelu.
- `herdr worktree create` zakłada osobną przestrzeń roboczą na każdy worktree. Żeby workerzy byli obok siebie, foreman sam robi `git worktree add` i otwiera panele z `--cwd`.
- Agent w panelu herdr ma `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`.
- Claude Code pokazuje okno zaufania w każdym nowym worktree (potwierdza herdr-hive). `agy` ma listę `trustedWorkspaces` w `~/.gemini/antigravity-cli/settings.json`.

## Pozostawione budowniczemu

- Maksymalna liczba workerów (propozycja: 6, w konfiguracji) i limit czasu workera.
- Format listy propozycji, który workerzy oddają liderowi (propozycja: plik JSON albo Markdown w `.foreman/` w worktree, żeby lider nie czytał ekranu).
- Dokładne sondy dla rodzajów, których Kuba nie ma (codex, copilot, cursor, kimi i inne); nieznany rodzaj traktowany jako „nieznany model”.
- Ostateczna nazwa.
