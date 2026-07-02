# Förslag: en app, två avdelningar

Status: FÖRSLAG — inget byggs förrän du godkänt. Dialog sker i appen (chatten),
inte via mail.

## 1. Arkitekturbeslut

Slå ihop de två tänkta forkarna till **en enda `app`-Worker** med två avdelningar
som växlas via en **hamburgermeny**:

- **Avdelning A — Ansökningsunderlag** (socialtjänst). Redan byggt (Fas 5).
- **Avdelning B — Publik katalog + prisbevakning.** Ny.

Delad auth, session, D1 och kodbas.

**Besparing mot två separata appar:**
- En Worker (ett route-/domänslot) i stället för två.
- Prisbevakning blir ett **steg i den befintliga engine-cronen** (`*/5`), inte en
  separat `alerts`-Worker med egen cron-trigger → ett cronjobb mindre.
- En deploy att underhålla (auto-deployar nu).

## 2. Konton & auth (byte av skyddsmodell)

Idag ligger hela `app` bakom **Cloudflare Access** (bara operatören kommer in).
För publik användning måste `app` **ut ur Access** och grindas på **app-konton**:

- **OAuth med de stora operatörerna** (Microsoft/Google/Apple) — samma mönster som
  politiker-kontakt. Plus befintlig e-post+lösenord.
- **Roller:** `user` (vanlig) och `admin` (du). Operatörs-privat idag —
  AI-nyckel-inställningar, CSV-beskriv-verktyget, katalog-drift — grindas per
  roll i stället för av Access.
- Publika ytor (katalogbläddring) kan läsas utan konto; att spara underlag,
  bevaka pris eller föreslå sidor kräver inloggning.

> Detta är den enda större implikationen av hopslagningen: Access → app-konton.
> Medvetet val, listas här svart på vitt.

## 3. Avdelning A — Ansökningsunderlag (befintligt)

Mindre justeringar för publik kontext:
- Flytta in under hamburger-navet som "avdelning".
- Fungerar redan per konto (bistand_items). Ingen datamodell-ändring.

## 4. Avdelning B — Publik katalog + prisbevakning (ny)

### 4.1 Katalog & urval
- Bläddra/sök de ~32k produkterna i D1.
- **Tre urvalslägen:** välj **kategori**, **enskilda produkter**, eller **allt**.
  (Kräver att `products.category` fylls — sker efterhand när fetchern crawlar;
  se Fas 6-beroendet.)
- Produktsida: titel, pris, prishistorik, direktlänk, AI-beskrivning.

### 4.2 Prisbevakning
- Användaren bevakar produkter/kategorier → larm vid prisfall.
- **Logik som ett steg i engine-cronen** (`checkPriceDrops`): LAG över
  `price_history`, tröskel (t.ex. ≥5 % och ≥100 kr), `alert_cooldown` (finns
  redan i schemat).
- **Larmkanaler** (per konto, valbara, av/på-toggle): e-post, ntfy/Pushover,
  Slack, Telegram, webhook. Modulärt — en kanal = en secret/config; osatt = av.
  (Ingen Discord — utgått.)

## 5. Nya sidor / routes (konkret)

| Route | Avd. | Beskrivning | Auth |
|-------|------|-------------|------|
| `/` | — | Landning + hamburgermeny (välj avdelning) | publik |
| `/underlag` (finns) | A | Utskrivbart ansökningsunderlag | konto |
| `/katalog` | B | Bläddra/sök, filtrera på kategori | publik läsning |
| `/produkt/:id` | B | Produktsida (pris, historik, länk, beskrivning) | publik |
| `/bevakning` | B | Mina prisbevakningar + larmkanaler | konto |
| `/konto` | — | Profil, OAuth-koppling, roller | konto |
| `/admin` | — | Katalogdrift, godkännande-kö för sidförslag | admin |
| `/foresla-sida` | B | Användare föreslår en ny sida (se §6) | konto |

## 6. Användar-inskickade sidförslag → godkännande-grind

Detta är det enda som får trigga mail till dig:

1. En slutanvändare föreslår en sida via `/foresla-sida`.
2. Jag skriver koden för förslaget (i en gren/PR, ej deployad).
3. **Mail till anders.eriksson@denied.se** med förslaget + länk till koden.
4. **Du bedömer** (ifall något fuffens) och godkänner/avslår.
5. Först vid explicit godkännande deployas den.

Allt annat (som detta förslag) sker i chatten — aldrig mail.

## 7. Datamodell-tillägg (D1)

- `accounts`: `role TEXT DEFAULT 'user'`, OAuth-koppling (`oauth_provider`,
  `oauth_sub`).
- `price_watch (account_id, product_id|category, created_at)`.
- `alert_channels (account_id, kind, config_json, enabled)`.
- `page_suggestions (id, account_id, title, spec, status, created_at)` — kön för §6.
- `alert_cooldown`, `bistand_items` finns redan.

## 8. Beroende: Fas 6 / fetchern

Avd. B:s katalog blir bara färsk om **fetchern kör persistent** och matar D1
(kategori, pris, prishistorik). Idag kör den inte (1 551 render_jobs ligger).
Så: gör fetchern persistent (precondition), sen Fas 6-rivning av postgres, sen
Avd. B ovanpå en självförsörjande katalog.

## 9. Beslut (godkända 2026-07-01)

1. **Access → OAuth-konton + roller: JA.** `app` blir publik, grindas per konto/roll.
2. **OAuth-operatörer:** Microsoft + Google + Apple + e-post/lösenord.
3. **Larmkanaler:** e-post + Slack + ntfy/Pushover + Telegram (alla fyra, modulära).
4. **Bygg-ordning:** fetcher → Fas 6 FÖRST (säkra färsk, självförsörjande katalog),
   sen Avd. B ovanpå.
