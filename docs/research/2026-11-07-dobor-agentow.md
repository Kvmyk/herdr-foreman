# Dobór agentów: research

Stan na 2026-11-07. Pytanie: skąd lider ma wiedzieć, którego agenta dać do której części pracy, tak żeby to działało także za rok, kiedy modele i programy będą inne.

## Wnioski w skrócie

1. **Rodzaj agenta to nie jego możliwości.** O wyniku decydują trzy rzeczy naraz: program (claude, opencode, pi...), model, na którym działa, i dostęp (subskrypcja, klucz API, limit). U Kuby `opencode` ostatnio działał na GPT-5.3-Codex przez Copilota, ale ma też skonfigurowany lokalny qwen2.5-coder 7B; `pi` działa tylko na lokalnym gpt-oss-20b. Ten sam rodzaj może być mocny albo bardzo słaby zależnie od ustawionego modelu.
2. **Żaden model nie wygrywa we wszystkim.** W CodeRouterBench (~10 tys. zadań, 9 kategorii) najlepszy w każdej kategorii był jeden z pięciu różnych modeli. Claude Opus 4.6 miał najlepszą średnią, ale np. w generowaniu testów Qwen3-Max miał 82,7% wobec 39,2% Opusa. [1]
3. **Program zmienia wynik tego samego modelu o 5–17 punktów.** GPT-5.5: 83,4% w Codex CLI i 78,2% w Terminus 2 [3]. Claude Opus 4.6: 58,0% w Claude Code i 74,7% w Terminus-KIRA [4]. Ocena samego modelu nie wystarcza; liczy się para program + model.
4. **Rankingi się rozjeżdżają i szybko starzeją.** Dla SWE-bench Pro różne serwisy podają w tym samym miesiącu innego lidera (Claude Opus 5.5 89,9%, Gemini 3 Pro 84,8%, Claude Opus 4.8 69,2%) [5][6][3]. Najnowsze modele (Opus 5.5, GPT-6.x, Gemini 4 Argon) przez tygodnie nie mają wyników na tablicach. Tabela wpisana na sztywno w kod będzie błędna po kilku tygodniach.
5. **Brak danych jest większym problemem niż słabe rozumowanie lidera.** Router na Claude Sonnet, któremu dodano statystyki wyników per kategoria, poprawił się z 41,4% do 47,7% (+15% względnie). Dobór z pamięcią wcześniejszych wyników działał najlepiej i jako jedyny dobrze zniósł zadania innego typu niż treningowe; stałe klasyfikatory spadły tam z 47% do 21%. [1]
6. **Przy przeglądzie i bezpieczeństwie opłaca się różnorodność.** Modele z różnych rodzin znajdują częściowo różne luki; połączenie kilku modeli dawało 10–12% lepsze wykrywanie niż pojedynczy model. [7][8] Ważne: różnorodność to różne rodziny modeli, nie różne programy. `claude` i `opencode` z Claude przez Copilota to ten sam model.
7. **Zainstalowany to nie to samo co działający.** U Kuby `gemini` jest zainstalowany, ale nie ma ani logowania, ani klucza API, a darmowy i osobisty dostęp do Gemini CLI skończył się 18.06.2026 (następcą jest Antigravity CLI, `agy`) [9]. `pi` działa tylko wtedy, gdy uruchomione jest LM Studio.
8. **Limity są realnym ograniczeniem.** Claude Pro ma okno 5-godzinne i limit tygodniowy, wspólny dla czatu i Claude Code [10]. Copilot liczy modele z mnożnikami (Claude Opus 4.6/4.7: 27×, GPT-5.5: 7,5× promocyjnie), a od 1.06.2026 przechodzi na kredyty [11]. Kilku workerów na jednej subskrypcji wyczerpie ją kilka razy szybciej.

## Proponowany mechanizm doboru

Trzy warstwy wiedzy, od najbardziej stałej do najbardziej aktualnej. Lider dostaje wszystkie trzy przy planowaniu.

### 1. Inwentarz: co jest dostępne teraz (sprawdzane przy każdym starcie)

Dla każdego rodzaju z listy herdr, którego program jest w PATH, komenda startowa zbiera:

- wersję programu;
- czy jest zalogowany albo ma klucz (sonda niżej);
- dostępne modele i model domyślny;
- czy pyta o zgodę i jakie ma tryby uprawnień;
- czy dany dostęp jest lokalny, płatny za tokeny czy w ramach subskrypcji.

Agent bez działającego dostępu wypada z puli, a użytkownik dostaje jedno zdanie, dlaczego. Sondy sprawdzone lokalnie 2026-11-07:

| Rodzaj | Zalogowany? | Modele |
|---|---|---|
| claude | `claude auth status` (JSON: `loggedIn`, `subscriptionType`) | wybór przez `--model`; rodzina Claude |
| agy | `agy models` (działa tylko po zalogowaniu) | `agy models` |
| opencode | `opencode auth list` | `opencode models` (format `dostawca/model`); ostatnio używane w `~/.local/state/opencode/model.json` |
| pi | `pi auth check --provider <nazwa>` | `pi --list-models` (pokazuje tylko modele z działającym dostępem) |
| gemini | brak `~/.gemini/oauth_creds.json` i zmiennych `GEMINI_API_KEY`/`GOOGLE_API_KEY` = brak dostępu | — |
| codex | `codex login status` (wg dokumentacji, niesprawdzone, brak instalacji) | `-m <model>` |

Dla rodzajów, których sonda nie jest znana, lider traktuje agenta jako „nieznany model” i pyta użytkownika albo go pomija.

### 2. Wiedza ogólna: wbudowana, aktualizowana, nadpisywalna

Dwie osobne części, bo starzeją się w różnym tempie:

- **Cechy programów** (zmieniają się rzadko): sandbox, tryby uprawnień, tryb bez okna, wyjście JSON, czy pyta o zgodę, mocne strony samego programu. Plik w pluginie, nadpisywany w konfiguracji użytkownika.
- **Cechy modeli** (zmieniają się co tydzień): kontekst, cena, rozumowanie, data wydania pobierane automatycznie z models.dev (`https://models.dev/api.json`, ten sam katalog, z którego korzysta opencode) [12]. Do tego krótka, ręcznie utrzymywana lista tendencji rodzin modeli z datą i źródłem. Wpis starszy niż ~90 dni lider traktuje jako niepewny.

### 3. Doświadczenie: dziennik wyników u użytkownika

To ma być główne źródło wiedzy po kilku tygodniach używania (wniosek 5). Po każdym zadaniu lider zapisuje dla każdego workera:

- kategorię części (lista niżej), program, model;
- ile propozycji z jego listy użytkownik zatwierdził, a ile odrzucił (sygnał za darmo z kroku zatwierdzania);
- czy zmiany przeszły testy i przegląd lidera za pierwszym razem, ile było poprawek;
- czy utknął (`blocked`, przekroczony czas), ile trwał.

Przy planowaniu lider dostaje podsumowanie: dla każdej kategorii, która para program + model wypadała najlepiej. Reguła wyboru: póki w kategorii jest mniej niż ~5 wyników, decyduje wiedza ogólna. Potem przeważa dziennik, z małą szansą, że lider da część innemu agentowi, żeby nowe modele miały okazję się wykazać.

Kategorie części (z zastosowań, które Kuba podał): analiza działania aplikacji, audyt bezpieczeństwa, testowanie i szukanie błędów, naprawa błędu, nowa funkcja, refaktoryzacja, pisanie testów, dokumentacja.

### Reguły stałe (niezależne od rankingów)

- **Przegląd i bezpieczeństwo:** ten sam obszar dla dwóch różnych rodzin modeli, a lider łączy i odsiewa ustalenia.
- **Limity jako budżet:** drogie modele do decyzji i trudnych zmian, tańsze i lokalne do prac mechanicznych (szukanie, streszczanie plików). Lider nie daje dwóch workerów na tę samą subskrypcję, jeśli jest alternatywa.
- **Modele lokalne:** gpt-oss-20b nadaje się do prostych zadań z narzędziami [13]; qwen2.5-coder 7B (57,9% w edycji Aidera, kontekst ustawiony na 32K) praktycznie tylko do drobiazgów [13].

## Stan na dziś: agenci u Kuby (sprawdzone 2026-11-07)

| Agent | Wersja | Dostęp | Modele | Pytania o zgodę | Tryb bez okna |
|---|---|---|---|---|---|
| claude | 2.1.286 | claude.ai, plan Pro | rodzina Claude | domyślnie pyta; `--permission-mode` (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan), `--dangerously-skip-permissions` | `-p`, `--output-format json`, `--json-schema` |
| agy | 1.1.3 | zalogowany (Google) | `agy models`: Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B; w ustawieniach wybrany „Gemini 3.1 Pro (High)”, którego lista nie pokazuje | `--mode accept-edits/auto/plan`, `--dangerously-skip-permissions`; tryb `auto` na Windows wg poradnika od v1.4.4 [14] | `-p`, `--output-format json`, `--json-schema` |
| opencode | 1.3.3 | GitHub Copilot (oauth), Google (API), OpenRouter (API), darmowe `opencode/*`, lokalna Ollama | przez Copilota m.in. Claude Opus 5.5 / Sonnet 5.5 / Fable 5.1, GPT-5.3-Codex, GPT-6.x, Gemini 4 Argon, Grok 4.7, Kimi K3; ostatnio używany GPT-5.3-Codex | `opencode run --auto`; uprawnienia per narzędzie | `opencode run`, `--format json` |
| pi | 1.5.0 | tylko lokalne LM Studio | gpt-oss-20b (128K) | według opisów pi z założenia nie pyta o zgodę [15] (do sprawdzenia) | `-p`, `--mode json/rpc` |
| gemini | 0.11.3 | **brak** | — | — | — |

Co z tego wynika dla Kuby dziś:

- **opencode przez Copilota daje największą różnorodność:** modele GPT, Gemini, Grok i Claude w jednym programie. To naturalny drugi głos przy przeglądzie i bezpieczeństwie obok `claude`. Trzeba pilnować mnożników Copilota.
- **agy** daje drugi dostęp do Claude 4.6 i GPT-OSS 120B, poza limitem Claude Pro.
- **pi** nadaje się do prostych zadań, jeśli działa LM Studio.
- **gemini** trzeba wyłączyć albo podać klucz API.
- **Zaufanie do folderów:** `agy` ma w zaufanych folderach `C:\Users\Kuba`. Trzeba sprawdzić, czy worktree w podfolderze nie wywołają pytania o zaufanie, osobno dla `agy` i `claude`.

## Stan na dziś: programy i modele (migawka, zestarzeje się)

Terminal-Bench 2.0, zadania w terminalu, para program + model [2]: NexAU-AHE + GPT-5.5 84,7%, Codex CLI + GPT-5.5 82,2%, WOZCODE + Claude Opus 4.7 80,2%, TongAgents + Gemini 3.1 Pro 80,2%, Droid + GPT-5.3-Codex 77,3%. 142 wpisy, mediana 44%.

Terminal-Bench 2.1 [3]: Codex CLI + GPT-5.5 83,4%, Claude Code + Opus 4.8 78,9%, Terminus 2 + GPT-5.5 78,2%, Gemini CLI + Gemini 3.1 Pro 70,7%. Według tego źródła Codex CLI zużywa ok. 4× mniej tokenów niż Claude Code przy podobnych zadaniach.

Opinie praktyków (słabe dowody, blogi porównawcze [16][3]), zgodne między źródłami:

- Claude Code: zmiany w wielu plikach, refaktoryzacje, planowanie zmian w całym repo.
- Codex: przegląd kodu, zadania terminalowe i CI, oszczędność tokenów.
- Gemini: czytanie bardzo dużych ilości kodu (kontekst 1M).
- Wzorzec powtarzany w kilku źródłach: jeden agent pisze, drugi z innej rodziny przegląda.

## Jakość źródeł

- **Pewne:** dokumentacje (Gemini CLI, Antigravity, opencode, models.dev), artykuły arXiv, sondy uruchomione lokalnie.
- **Średnie:** tablice Terminal-Bench (wyniki zgłaszane przez autorów programów).
- **Słabe:** agregatory benchmarków i blogi porównawcze. Agregatory podają sprzeczne liczby, a blogi zawierają oczywiste błędy (np. GPT-5.5 przypisany Anthropic). Z nich brane są tylko tendencje zgodne w kilku źródłach.

## Propozycje do specyfikacji

1. Wykrywanie agentów zwraca trójki program + model + dostęp. Agent bez działającego dostępu wypada z puli z jednym zdaniem wyjaśnienia.
2. Wiedza ogólna w dwóch częściach: cechy programów (plik w pluginie) i cechy modeli (models.dev + krótka lista tendencji z datami). Obie nadpisywalne w konfiguracji.
3. Dziennik wyników lokalnie u użytkownika i statystyki per kategoria podawane liderowi przy planowaniu. Główny sygnał: zatwierdzenia propozycji przez użytkownika oraz testy i przegląd lidera.
4. Przy przeglądzie i bezpieczeństwie: dwie różne rodziny modeli na ten sam obszar.
5. Limity subskrypcji jako budżet przy przydziale.

## Źródła

1. Agent-as-a-Router: Agentic Model Routing for Coding Tasks, arXiv 2606.22902: https://arxiv.org/html/2606.22902v1
2. Terminal-Bench 2.0 leaderboard (Snorkel): https://snorkel.ai/leaderboard/terminal-bench-2-0/
3. Terminal-Bench 2.1, czerwiec 2026, aktualizacja 2026-11-07: https://codex.danielvaughan.com/2026/06/11/terminal-bench-2-1-june-2026-benchmark-landscape-codex-cli-harness-engineering-model-scores/
4. The Harness Effect: https://codex.danielvaughan.com/2026/04/19/the-harness-effect-same-model-different-tool-different-score/
5. BenchLM, SWE-bench Pro: https://benchlm.ai/benchmarks/swe-bench-pro
6. SWE-bench Pro (agregator): https://anotherwrapper.com/tools/llm-pricing/evals/swe-bench-pro
7. Diverse LLMs vs. Vulnerabilities: https://dl.acm.org/doi/pdf/10.1145/3786181.3788719
8. Ensembling Large Language Models for Code Vulnerability, arXiv 2509.12629: https://arxiv.org/pdf/2509.12629
9. Transitioning Gemini CLI to Antigravity CLI: https://github.com/google-gemini/gemini-cli/discussions/27274
10. Limity Claude Code: https://www.morphllm.com/claude-code-usage-limits
11. Mnożniki modeli w Copilocie: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
12. models.dev: https://models.dev/api.json
13. Lokalne modele do kodu: https://ianlpaterson.com/ai/best-local-llm/
14. Antigravity CLI, tryby i uprawnienia: https://www.aibuilderclub.com/blog/antigravity-cli-guide ; tryb bez okna: https://antigravity.google/docs/cli/headless/
15. pi.dev, przegląd: https://urandom.io/blog/2026-03-07-pi-dev-deep-dive
16. Codex vs Claude Code vs Gemini CLI (Tembo, lipiec 2026): https://www.tembo.io/blog/codex-vs-claude-code-vs-gemini-cli
17. Triage: routing zadań do poziomów modeli, arXiv 2604.07494: https://arxiv.org/pdf/2604.07494
18. opencode CLI: https://opencode.ai/docs/cli
