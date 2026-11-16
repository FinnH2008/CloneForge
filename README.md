# CloneForge Studio

CloneForge Studio ist ein webbasierter Generator für **Clone-Hero-Charts** und
**6-Fret-GHL-Charts**. Audiodateien werden analysiert, automatisch in
spielbare Tracks umgewandelt und zusammen mit Metadaten, Lyrics und optionalem
Video als ZIP-Datei exportiert.

## Funktionen

- Analyse von MP3-, MP4-, WAV-, OGG- und M4A-Dateien
- Automatische BPM-, Takt- und Schwierigkeitsanalyse
- Chart-Generator für 5-Fret-Gitarre und 6-Fret-GHL
- Highway-Editor zur manuellen Bearbeitung von Noten, Star Power und Ticks
- MusicBrainz-Suche für Titel, Interpret, Album, Genre und Cover
- Lyrics-Suche über LRCLIB inklusive synchronisierter Lyrics
- Import von `.lrc`- und Textdateien
- Audio- und optionaler Video-Export als Clone-Hero-Chart-Archiv
- Demo-Modus zum Ausprobieren ohne Audiodatei

## Voraussetzungen

- Node.js 20 oder neuer
- npm, pnpm oder Bun
- Optional: ein Gemini-API-Key für die serverseitigen KI-Funktionen

## Installation

```bash
git clone https://github.com/FinnH2008/CloneForge.git
cd CloneForge
npm install
```

Lege anschließend eine `.env`-Datei auf Basis von `.env.example` an:

```env
GEMINI_API_KEY=dein_api_key
APP_URL=http://localhost:3000
```

## Entwicklung

```bash
npm run dev
```

Die Anwendung ist danach unter [http://localhost:3000](http://localhost:3000)
erreichbar.

## Build und Produktion

```bash
npm run build
npm start
```

Weitere verfügbare Skripte:

| Skript | Beschreibung |
| --- | --- |
| `npm run lint` | TypeScript-Prüfung ohne Ausgabe |
| `npm run preview` | Lokale Vorschau des Vite-Builds |
| `npm run clean` | Entfernt Build-Ausgaben |

## Verwendung

1. Eine Audio- oder Videodatei im Tab **Analyse & Tags** auswählen.
2. BPM, Metadaten und optional Lyrics prüfen oder automatisch abrufen.
3. Die erzeugten Noten im **Editor** kontrollieren und anpassen.
4. Im Bereich **Erweitert** Exportoptionen und Songdaten festlegen.
5. Das fertige Chart-Archiv herunterladen und in Clone Hero importieren.

Für einen schnellen Test kann der integrierte Demo-Modus verwendet werden.

## Projektstruktur

```text
src/
├── components/   UI für Analyse, Editor, Lyrics und Einstellungen
├── types/        Gemeinsame TypeScript-Typen
└── utils/        Audioanalyse, Chart-Erzeugung, Export und Lyrics
server.ts         Express-Server und externe API-Proxies
public/           Statische Assets
```

MusicBrainz, Cover Art Archive und LRCLIB werden über den Express-Server
abgerufen. Dadurch bleiben externe API-Aufrufe und Rate-Limiting zentral
gebündelt.

## Lizenz

Die Lizenz ist derzeit noch nicht festgelegt. Bitte vor einer öffentlichen
Weitergabe die Rechte an verwendeten Audio-, Video-, Cover- und Lyrics-Daten
prüfen.
