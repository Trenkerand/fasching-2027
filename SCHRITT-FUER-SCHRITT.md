# Fasching 2027 – neue Webseite und GMX-Dashboard

## Was enthalten ist
- Öffentliches Anmeldeformular (ab 18 Jahren)
- Sechs Faschingsumzüge mit Datum (unbestätigte Termine als „Termin folgt“), live Platzanzeige x/70 und automatischer Sperre bei 70
- Versand der Anmeldung an `Fasching.2027@gmx.de`
- Passwortgeschützter Veranstalterbereich
- GMX-IMAP-Abruf automatisch alle 5 Minuten und per Knopfdruck
- Erste automatische Erkennung von Namen, Alter und Umzug aus E-Mail-Texten und HTML-Tabellen
- SQLite-Datenbank für gespeicherte Anmeldungen, Nachrichten und erkannte Teilnehmer
- Teilnehmerliste: nur Namen, Klick zeigt Details; einzelne Teilnehmer je Umzug löschen
- Gespeicherte Anmeldungen werden sofort auf die 70 Plätze angerechnet, auch wenn der Mailversand vorübergehend fehlschlägt

**Wichtig:** Die automatische Erkennung ist eine erste Version. Eine E-Mail kann mehrere erkannte Teilnehmer enthalten; bei externen Nachrichten ist die Zuordnung nicht immer zuverlässig. E-Mail-Tabellen können sehr unterschiedlich aufgebaut sein. Vor dem echten Einsatz bitte mit einigen typischen, anonymisierten Beispiel-E-Mails testen. Erkennungen mit Status „Prüfen“ immer kontrollieren.

## Termine (Stand 25.11.2026)
- Triftern: 31.01.2027, 14:00 Uhr (offizielle Gemeindeangabe)
- Tettenweis: 05.02.2027, ab 17:00 Uhr (vorläufig, externe Veranstaltungsliste; bitte bestätigen)
- Neuötting: 06.02.2027, 14:00 Uhr (Tourismus-Veranstaltungskalender)
- Eggenfelden, Wurmannsquick, Peterskirchen: noch kein sicher bestätigter Termin

## Teil A – GMX vorbereiten
1. Bei GMX anmelden.
2. In den E-Mail-Einstellungen den POP3-/IMAP-Zugriff aktivieren.
3. In den GMX-Sicherheits-/Account-Einstellungen ein **App-Passwort** erstellen, falls GMX diese Option für dein Konto anbietet.
4. Das App-Passwort nur in Render als geheime Umgebungsvariable eintragen – niemals in GitHub-Code, HTML oder hier im Chat.
5. GMX-Zugangsdaten:
   - IMAP: `imap.gmx.net`, Port `993`, SSL/TLS
   - SMTP: `mail.gmx.net`, Port `587`, STARTTLS

## Teil B – Projekt auf GitHub hochladen
1. Auf https://github.com anmelden.
2. Oben rechts auf **+ → New repository** klicken.
3. Repository-Name: `fasching-2027`.
4. Sichtbarkeit möglichst **Private** auswählen.
5. **Create repository** anklicken.
6. ZIP-Datei entpacken.
7. Die enthaltenen Dateien und den Ordner `public` in das neue Repository hochladen (nicht den übergeordneten ZIP-Ordner).
8. **Commit changes** anklicken.

## Teil C – Webseite mit Render veröffentlichen
1. Auf https://render.com ein Konto erstellen bzw. anmelden.
2. **New + → Blueprint** wählen.
3. GitHub verbinden und das Repository `fasching-2027` auswählen.
4. Render liest die Datei `render.yaml` und zeigt den Dienst an.
5. Dienst erstellen/deployen.
6. Falls Render nach Werten fragt, diese geheim eintragen:
   - `DASHBOARD_PASSWORD`: ein neues, starkes Passwort für den Veranstalterbereich
   - `GMX_EMAIL`: `Fasching.2027@gmx.de`
   - `GMX_APP_PASSWORD`: das zuvor bei GMX erstellte App-Passwort
   - `SESSION_SECRET`: lange zufällige Zeichenfolge (wenn Render sie nicht automatisch erzeugt)
7. Warten, bis der Deploy abgeschlossen ist. Render zeigt dann eine Adresse wie `https://fasching-2027-xxxx.onrender.com`.
8. Diese Adresse ist deine neue Webseite. Speichere sie.

**Hinweis zu Kosten und Verfügbarkeit:** Ein dauerhafter Webdienst mit dauerhaftem Speicherplatz ist je nach Render-Tarif kostenpflichtig. Prüfe die aktuellen Preise und Bedingungen direkt bei Render, bevor du einen kostenpflichtigen Dienst bestätigst. Der Datenträger unter `/var/data` ist wichtig, damit die gespeicherten E-Mails/Teilnehmer nach einem Neustart erhalten bleiben.

## Teil D – Funktion testen
1. Öffne die neue Render-Webadresse.
2. Teste das Anmeldeformular mit einer eigenen Testanmeldung.
3. Prüfe, ob die E-Mail im GMX-Postfach angekommen ist.
4. Öffne den Veranstalterbereich und melde dich mit dem `DASHBOARD_PASSWORD` an.
5. Klicke auf **E-Mails jetzt aktualisieren**.
6. Prüfe, ob die Anmeldung im Dashboard erscheint, ob die Zahl x/70 hochgeht und ob die Testmail unter „Eingegangene Faschings-E-Mails“ auftaucht. Klicke auf den Namen und prüfe die Details.
7. Teste auch das Löschen eines Teilnehmers aus einem Umzug.
8. Nach erfolgreicher Einrichtung läuft der automatische Abruf standardmäßig alle fünf Minuten.

## Teil E – GitHub Pages?
Diese Version läuft als komplette Node-Webanwendung auf Render. GitHub ist der Ort, an dem du den Quellcode speicherst und Änderungen verwaltest. **GitHub Pages allein reicht für diese Version nicht**, weil es keinen sicheren IMAP-Serverprozess ausführen kann.

## Sicherheit
- Niemals GMX-Passwort oder App-Passwort in eine Datei im Repository schreiben.
- Repository privat halten.
- Für `DASHBOARD_PASSWORD` ein eigenes, starkes Passwort verwenden; nicht das GMX-Passwort.
- Wenn Zugangsdaten versehentlich veröffentlicht wurden: sofort bei GMX widerrufen/ändern.
- Das Dashboard ist mit einem serverseitig geprüften Passwort und einer begrenzten Anzahl von Loginversuchen geschützt. Für größere öffentliche Produktivseiten sind zusätzliche Sicherheitsprüfungen empfehlenswert.
- Teilnehmerdaten sind personenbezogene Daten: Datenschutzhinweise, Aufbewahrungsdauer und Zugriffsrechte vor Veröffentlichung prüfen.
- Die Platzanzeige umfasst gespeicherte Webanmeldungen und zusätzlich erkannte externe E-Mail-Teilnehmer. Doppelte oder unklare externe E-Mails bitte im Dashboard prüfen.
- Die Software zeigt nur Fasching-/Umzugs-bezogene E-Mails an. Die Erkennung kann dennoch falsche Zuordnungen machen; bitte unklare Fälle prüfen.

## Wichtige Einschränkung
Die ZIP-Datei enthält die Anwendung, aber sie wurde nicht mit einem echten GMX-Postfach und einem Live-Render-Server durchgetestet. Vor öffentlicher Freigabe bitte unbedingt die oben beschriebenen Tests durchführen.

## Wenn etwas nicht klappt
- „GMX-Zugangsdaten fehlen“: Render → Service → Environment und Variablen kontrollieren.
- Login klappt nicht: `DASHBOARD_PASSWORD` in Render prüfen und neu deployen.
- E-Mails werden nicht gefunden: IMAP-Zugriff in GMX prüfen; außerdem muss im Betreff oder Inhalt ein Begriff wie „Fasching“, „Faschingszug“ oder „Umzug“ vorkommen.
- Webseite zeigt nach Änderungen alte Version: Render-Deployment kontrollieren.