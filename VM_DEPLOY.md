# VM 배포 메모

이 봇은 GitHub에 코드를 올린 뒤, VM에서 `git clone` 또는 `git pull`로 받아 실행하는 방식이 가장 편합니다.

중요: `.env`에는 봇 토큰이 들어가므로 GitHub에 올리면 안 됩니다. 이 저장소의 `.gitignore`는 `.env`를 제외하도록 설정되어 있습니다.

## 1. 로컬에서 GitHub에 올리기

현재 폴더:

```powershell
cd "C:\Users\MSI\OneDrive\바탕 화면\디코봇\k"
```

처음 한 번만:

```powershell
git init -b main
git add .gitignore .env.example README.md VM_DEPLOY.md ecosystem.config.cjs package.json package-lock.json src
git commit -m "Initial problem upload bot"
git remote add origin https://github.com/yddfhbh/nyannyan.git
git push -u origin main
```

이미 GitHub 저장소에 커밋이 있어서 push가 거절되면:

```powershell
git pull --rebase origin main
git push -u origin main
```

## 2. VM 접속

로컬 PowerShell에서:

```powershell
ssh -i "$env:USERPROFILE\Downloads\arm-ssh-key" ubuntu@168.107.43.210
```

## 3. VM에 Node.js와 Git 준비

VM 안에서:

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 4. 봇 받기

VM 안에서:

```bash
git clone https://github.com/yddfhbh/nyannyan.git
cd nyannyan
npm ci
cp .env.example .env
nano .env
```

`.env`에는 VM에서 직접 봇 토큰을 넣습니다.

```env
DISCORD_TOKEN=봇_토큰
DISCORD_GUILD_ID=서버_ID
SOURCE_CHANNEL_IDS=1509460473060261949
PROBLEM_CATEGORY_ID=1509459977801044029
UNIT_CHANNEL_PREFIX=
UNIT_CHANNEL_MAP=
```

먼저 테스트 실행:

```bash
npm start
```

## 5. 계속 켜두기

테스트가 잘 되면 `Ctrl+C`로 끄고 PM2로 실행합니다.

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup`을 실행하면 마지막에 `sudo env ... pm2 startup ...` 형태의 명령어가 출력됩니다. 그 줄을 복사해서 한 번 더 실행해야 재부팅 후에도 자동 시작됩니다.

상태 확인:

```bash
pm2 status
pm2 logs nyannyan-problem-bot
```

코드를 수정해서 GitHub에 다시 올린 뒤 VM에서 갱신할 때:

```bash
cd ~/nyannyan
git pull
npm ci
pm2 restart nyannyan-problem-bot
```
