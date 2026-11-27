# Telepítés Debian / Ubuntu szerverre (apt, SSH-n bent a szerveren)

A lépések apt-alapú rendszerre vonatkoznak: Ubuntu 22.04 / 24.04 vagy Debian 12. Minden
parancs `root`-ként vagy `sudo`-val fut. A rendszer két konténer: `web` (nginx, az oldal) és
`importer` (Python, a CSV-k feldolgozása). A szerverre csak Docker és Git kell.

## 1. Docker és Git telepítése (egyszer)

A Docker hivatalos apt tárolójából (az Ubuntu/Debian saját `docker.io` csomagja régi
Compose-t hoz). Előbb a szükséges eszközök:

```bash
sudo apt-get update
```

```bash
sudo apt-get install -y ca-certificates curl git
```

A Docker aláíró kulcsa (a parancs magától felismeri, hogy Ubuntu vagy Debian fut):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
```

```bash
sudo curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" -o /etc/apt/keyrings/docker.asc
```

```bash
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

A tároló felvétele:

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Telepítés:

```bash
sudo apt-get update
```

```bash
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Éles szerveren a Docker induljon el bootoláskor is (apt-tal telepítve ez alapból így van;
a konténerek `restart: unless-stopped` beállítással maguktól újraindulnak):

```bash
sudo systemctl enable --now docker
```

Ellenőrzés (Compose 2.24 vagy újabb kell):

```bash
docker compose version
```

## 2. A projekt letöltése

```bash
sudo git clone https://github.com/amondo118/ProAlpha-Monitor.git /srv/proalpha-monitor
```

```bash
cd /srv/proalpha-monitor
```

Ha a repó privát, a `git clone` felhasználónevet és jelszót kér: a jelszó helyére egy
GitHub Personal Access Token kell (GitHub → Settings → Developer settings → Tokens,
csak olvasási joggal), vagy SSH deploy key.

## 3. Beállítások (`.env`)

```bash
sudo cp .env.example .env
```

```bash
sudo nano .env
```

A fontos sor: **`EXPORTS_DIR`**, az a mappa, ahová a SAP/proALPHA a napi CSV-ket menti,
például:

```
EXPORTS_DIR=/srv/sap-exports
WEB_PORT=80
```

Ha a mappa még nem létezik:

```bash
sudo mkdir -p /srv/sap-exports
```

### Ha az export hálózati megosztáson van (SMB/CIFS)

A megosztást a szerveren kell felcsatolni, a Compose ezt a mappát látja. Kell hozzá a
`cifs-utils` csomag:

```bash
sudo apt-get install -y cifs-utils
```

Bejegyzés az `/etc/fstab`-ban (csak olvasásra elég):

```
//fajlszerver/sap-export  /srv/sap-exports  cifs  credentials=/root/.smb-sap,ro,uid=0,gid=0,_netdev,nofail  0  0
```

A `/root/.smb-sap` fájlba kerül a felhasználó és a jelszó (`username=…`, `password=…`,
jogosultság: `sudo chmod 600 /root/.smb-sap`). Felcsatolás:

```bash
sudo mount -a
```

## 4. Indítás

```bash
sudo docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

Az éles indítás **nem** használja a fejlesztői `compose.override.yaml`-t: nincs mintaadat
(`FAKE_DATA=0`), a frontend a képbe van építve, a naplók méretkorlátosak.

Állapot (a `web` mellett `healthy` kell álljon):

```bash
sudo docker compose ps
```

Importer napló (itt látszik, ha egy CSV-t beolvasott, vagy ha valami hibás):

```bash
sudo docker compose logs -f importer
```

Az első exportig az oldal ezt írja: „Még nincs importált adat”. Amint egy CSV megjelenik
az `EXPORTS_DIR`-ben, kb. 1–2 percen belül beolvassa (megvárja, hogy a fájl 60 másodpercig
ne változzon, hogy félig írt fájlt ne olvasson be).

## 5. Tűzfal

Ha a szerveren `ufw` fut (Ubuntun gyakori), nyisd meg a HTTP portot:

```bash
sudo ufw allow 80/tcp
```

Állapot:

```bash
sudo ufw status
```

Az oldal ezután: `http://<szerver-neve-vagy-IP>/` (más port esetén `:PORT` a végére).

## 6. Frissítés új verzióra

```bash
cd /srv/proalpha-monitor
```

```bash
sudo git pull
```

```bash
sudo docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

Az adatok nem vesznek el: az importer a meglévő exportokból újra előállítja őket.

Régi, már nem használt image-ek törlése időnként (helyet szabadít fel):

```bash
sudo docker image prune -f
```

## 7. Konfiguráció módosítása (`config/*.toml`)

Az oszlopnevek, kódlisták, közös időszakok a `config/` mappában vannak, és **újraindítás
nélkül** érvényesek: az importer egy percen belül észleli a változást és újra beolvas.

Ajánlott a módosítást a repóban végezni (commit + push), majd a szerveren `git pull`.
Ha a szerveren közvetlenül szerkesztesz, a következő `git pull` ütközhet; ilyenkor:

```bash
sudo git stash
```

```bash
sudo git pull
```

```bash
sudo git stash pop
```

Hibás config esetén az importer a naplóba írja a hibát, és a legutóbbi jó adat marad fent.

## 8. Hasznos parancsok

| Mit | Parancs |
|---|---|
| Leállítás | `sudo docker compose -f compose.yaml -f compose.prod.yaml down` |
| Újraindítás | `sudo docker compose -f compose.yaml -f compose.prod.yaml restart` |
| Napló, web | `sudo docker compose logs --tail 50 web` |
| Importer tesztek | `sudo docker compose -f compose.yaml -f compose.prod.yaml run --rm importer python -m unittest` |
| Milyen fájlokat lát az importer | `sudo docker compose exec importer ls -l /exports` |

## Hibakeresés

- **„Permission denied” az exports mappára:** a fájlok nem olvashatók: `ls -l /srv/sap-exports`;
  hálózati megosztásnál ellenőrizd, hogy fel van-e csatolva: `mount | grep sap-exports`.
- **Nem jön be az oldal:** `sudo docker compose ps` (fut-e a `web`), tűzfal (5. pont),
  foglalt-e a port: `sudo ss -ltnp | grep :80` (pl. egy előre telepített `apache2` vagy `nginx`).
- **Az oldalon a ⚠ ikon piros:** az export 30 óránál régebbi (hétvégét nem számolva), vagy
  egy ellenőrzés nem stimmel. Részletek a ⚠ fülön és az importer naplójában.
- **„port is already allocated”:** más szolgáltatás (pl. egy másik webszerver) használja
  a 80-as portot; állíts be másik `WEB_PORT`-ot a `.env`-ben.
