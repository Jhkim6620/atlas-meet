# Atlas Meet

팀원이 초대 링크로 모여 화상회의를 하고, 각자 켠 마이크의 한국어 발언을 함께 읽는 웹 앱입니다. 소규모 회의용 WebRTC 연결과 회의 서버, 참석자별 음성 수집, 발언 기록 화면을 구현했습니다. 음성 인식은 OpenAI의 gpt-transcribe API, Apple Silicon Mac에 설치한 Qwen3-ASR, 또는 자체 서버의 한국어 Whisper로 처리합니다. 회의 준비 화면에 현재 사용 중인 엔진이 표시됩니다.

[팀용 Linux 서버 설치](#팀용-linux-서버-배포)

## 회의 열기

1. 회의 이름과 내 이름을 입력합니다. 회의 이름을 비워 두면 ‘팀 회의’가 됩니다.
2. 마이크나 카메라를 켜서 확인합니다. 내 말을 기록하려면 **내 발언 전사**를 켭니다. 입장 후에도 각각 바꿀 수 있습니다.
3. **회의 만들기**를 누른 뒤 **초대 링크 복사**로 팀원을 초대합니다. 팀원은 링크를 열거나 **초대로 참여**에 링크 또는 32자리 코드를 붙여넣습니다.
4. 말을 마치면 실시간 전사 패널에 이름, 발언 시각, 텍스트가 표시됩니다. **나가기**를 누르면 마지막 발언까지 처리한 후 기록이 열립니다. 전사 기록은 텍스트 파일로 내려받을 수 있습니다.

회의마다 동시 접속 상한은 8명입니다. 발언자는 소리를 구분해 추정하는 대신 각 브라우저의 마이크와 입장할 때 입력한 이름으로 식별합니다. 한 마이크를 여러 사람이 함께 쓰면 같은 이름으로 기록됩니다. 초대 링크를 가진 사람은 회의에 참여하고 이전 전사를 읽을 수 있습니다. 최근 회의 목록은 참여한 브라우저에 저장됩니다.

## 이 Mac에서 열기

[로컬 회의실 열기](http://localhost:4317)

이 Mac의 개발 원본은 Documents 아래에 있습니다. macOS가 이 폴더의 파일을 클라우드에 임시 보관하는 동안에도 회의를 열 수 있도록, 로컬 실행본과 전사 모델을 Application Support에 함께 설치했습니다. 서버가 꺼져 있을 때는 아래 명령으로 다시 시작합니다.

```sh
cd "$HOME/Library/Application Support/Atlas Meet/runtime"
HOST=127.0.0.1 npm start
```

## OpenAI 전사 연결

이 Mac에서 `scripts/connect-openai.command`를 실행하고 터미널의 숨김 입력란에 API 키를 붙여넣습니다. 연결 도우미는 짧은 합성 음성으로 실제 전사를 한 번 요청하고, 원문과 인식 결과를 나란히 표시합니다. 성공하면 이 Mac의 Atlas 전용 디렉터리에 키를 저장합니다. 새로고침 후 전사 표시를 확인하고 마이크와 내 발언 전사를 켭니다. 이미 회의 중이라면 회의를 마친 뒤 전환합니다.

OpenAI 모드에서는 전사를 켜고 외부 전송에 동의한 참석자의 발언 음성을 OpenAI로 전송하고, 반환된 텍스트를 회의 서버에 저장합니다. API 계정에 전사 사용료가 부과됩니다. 기본 설치는 키를 연결하기 전까지 서버의 한국어 Whisper를 사용합니다. 키를 연결한 후에도 로컬 엔진을 사용하려면 서버 실행 시 `ATLAS_STT_PROVIDER=local`을 지정합니다. [OpenAI 전사 가이드](https://developers.openai.com/api/docs/guides/speech-to-text) · [모델과 요금](https://developers.openai.com/api/docs/models/gpt-transcribe)

Linux Compose에서는 팀 도메인을 설정한 뒤 Node.js 또는 Python 3이 설치된 호스트에서 다음 명령을 실행합니다. 이후에도 서비스 갱신 시 같은 두 Compose 파일을 지정합니다.

```sh
bash scripts/connect-openai.command --compose
docker compose -f compose.yaml -f compose.openai.yaml up -d --build --wait
```

Node를 직접 운영할 때는 서버 환경에 `ATLAS_STT_PROVIDER=openai`와 `OPENAI_API_KEY_FILE` 또는 `OPENAI_API_KEY`를 설정할 수 있습니다. 브라우저에는 인증 키가 전달되지 않습니다.

## 소스에서 실행하기

Node.js 20 이상, npm, CMake, C/C++ 컴파일러, curl, tar와 SHA-256 검사 도구가 필요합니다. 프로젝트 디렉터리에서 아래 명령을 실행합니다. 첫 설치 때 전사 엔진 소스와 약 574 MB의 모델을 내려받아 체크섬을 검증합니다.

```sh
npm ci
npm run setup:speech
npm start
```

Apple Silicon Mac에서는 다음 명령으로 Qwen3-ASR 1.7B를 추가 설치할 수 있습니다. 설치 스크립트는 약 1.49 GB의 모델과 실행 파일을 내려받아 체크섬을 검증합니다. 설치 뒤에는 로컬 모드에서 Qwen을 사용합니다. 기존 한국어 Whisper를 선택하려면 서버 실행 시 `ATLAS_STT_PROVIDER=local ATLAS_LOCAL_STT_ENGINE=whisper`를 지정합니다. [Qwen 모델](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) · [CrispASR](https://github.com/CrispStrobe/CrispASR)

```sh
sh scripts/setup-qwen.sh
```

기본 포트는 4317입니다. 브라우저는 잠깐의 쉼을 같은 발언에 담고 연속 발언을 최대 약 25초 단위로 보냅니다. 서버는 Silero VAD로 음성이 감지된 발언을 전사하고 반환된 텍스트를 회의 기록에 저장합니다. 로컬 모드에서는 설치 후 인터넷 연결이나 API 키 없이 전사합니다. 엔진 상태는 [로컬 상태 페이지](http://localhost:4317/api/status)에서 확인할 수 있습니다.

## 팀용 Linux 서버 배포

Docker Engine과 Docker Compose v2가 설치된 Linux 서버 한 대, 공인 IPv4 주소, 팀에서 사용할 도메인을 준비합니다. 로컬 Whisper를 쓸 때 Linux 배포본은 CPU를, Apple Silicon Mac 설치본은 Metal 가속을 사용합니다. 첫 빌드는 컨테이너 이미지와 고정 버전의 인식 엔진·모델을 내려받으므로 인터넷에 연결되어 있어야 합니다.

1. 팀 도메인의 DNS A 레코드를 서버의 공인 IPv4로 연결합니다. 공유기나 클라우드 NAT 뒤라면 아래 포트를 동일한 번호로 서버에 전달합니다. 방화벽과 클라우드 보안 그룹에도 적용합니다.

   | 인바운드 포트 | 용도 |
   | --- | --- |
   | TCP 80, 443 | Caddy 인증서 발급·갱신, HTTPS 접속, 회의용 WebSocket |
   | UDP 3478, TCP 3478 | 브라우저에서 coturn 중계 서버로 접속 |
   | UDP 49160–49415 | coturn이 회의 미디어에 할당할 포트 |

2. 배포 압축 파일을 서버에서 풀고 도메인과 주소를 설정합니다. 예시의 도메인과 주소를 실제 값으로 바꿉니다.

   ```sh
   tar -xzf atlas-meet-server.tar.gz
   cd atlas-meet
   sh scripts/configure-server.sh meet.example.org 203.0.113.10
   ```

   서버 인터페이스에 사설 주소가 할당된 경우 세 번째 인수에 그 주소를 넣습니다.

   ```sh
   sh scripts/configure-server.sh meet.example.org 203.0.113.10 10.0.1.4
   ```

   설정 명령이 `.env`와 `.atlas-secrets/`에 두 종류의 키를 생성합니다. 회의 주최자에게는 `.atlas-secrets/room-creation-key`의 값을 전달합니다. `turn-shared-secret`은 앱과 coturn이 참석자별 임시 자격 증명을 발급하고 확인하는 데 사용합니다. 설정을 다시 실행해도 두 키는 유지됩니다.

3. 같은 디렉터리에서 실행합니다.

   ```sh
   docker compose config --quiet
   docker compose up -d --build --wait
   docker compose ps
   ```

4. 팀 도메인의 HTTPS 주소를 열고 **새 회의**에서 개설 키를 입력합니다. 회의가 열리면 **초대 링크 복사**를 누릅니다. 초대받은 사람은 링크와 자신의 표시 이름으로 입장합니다. 서로 다른 네트워크에 있는 두 기기에서 통화하고, 마이크와 **내 발언 전사**를 켠 후 양쪽에 발언이 표시되는지 확인합니다.

### 구성과 데이터 보관

Caddy가 HTTPS와 WebSocket 요청을 Node 회의 서버로 전달합니다. Node는 방 입장과 참가자 간 연결을 조율하고, 선택한 엔진이 인식한 발언을 저장합니다. 미디어를 직접 주고받기 어려운 참석자는 coturn을 경유합니다. 기본 중계 접속은 3478/UDP와 3478/TCP를 사용합니다. TCP 443만 허용하는 사내망에서 중계가 필요하면 별도의 TURN/TLS 주소를 구성해야 합니다. [Caddy 자동 HTTPS](https://caddyserver.com/docs/automatic-https) · [WebRTC 중계 서버](https://webrtc.org/getting-started/turn-server)

회의 기록은 Compose의 `rooms` 볼륨, 인증서 상태는 `caddy_data`와 `caddy_config` 볼륨에 보관합니다. 컨테이너를 재생성해도 같은 볼륨을 연결하면 기록을 다시 읽을 수 있습니다. 한 데이터 디렉터리에는 앱 인스턴스 하나를 연결합니다. 실시간 서비스 로그는 `docker compose logs -f app caddy turn`으로 볼 수 있습니다. 운영 중에는 팀 도메인의 `/api/status`에서 전사 엔진 준비 여부와 개설 키 사용 여부를 확인할 수 있습니다.

### 기존 인프라에 연결할 때

Compose 구성과 별개로 Node를 직접 실행할 수도 있습니다. 리버스 프록시는 Host 헤더를 보존하고 `/ws`의 WebSocket 업그레이드와 `/api/` 요청을 같은 앱으로 전달합니다.

| 환경 변수 | 용도 |
| --- | --- |
| HOST / PORT | 앱 수신 주소와 포트. 기본값은 0.0.0.0과 4317 |
| TLS_CERT_FILE / TLS_KEY_FILE | Node가 직접 HTTPS를 제공할 때 사용할 인증서와 개인 키 |
| ROOM_CREATION_KEY_FILE | 회의 개설 키 파일. 직접 실행하는 기본 로컬 구성에서는 키 없이 방을 만들 수 있음 |
| TURN_PUBLIC_HOST / TURN_URLS | 기본 TURN 도메인 또는 운영 중인 TURN URL 목록 |
| TURN_SHARED_SECRET_FILE / TURN_TTL_SECONDS | coturn과 공유할 서명 키 파일과 자격 증명 유효 기간. 기본 3,600초 |
| ICE_SERVERS | 기존 STUN/TURN 설정을 추가할 WebRTC JSON 배열 |
| ATLAS_DATA_DIR | 방별 전사와 참석 세션을 저장할 디렉터리. macOS 기본값은 ~/Library/Application Support/Atlas Meet/rooms, 다른 환경은 프로젝트 아래 data/rooms |
| ATLAS_WHISPER_CLI / ATLAS_WHISPER_MODEL | 별도로 설치한 whisper-cli 실행 파일과 다국어 모델의 절대 경로 |

## 한국어 대화 전사 평가

`python3 scripts/evaluate-speech.py 모델파일 [비교모델파일]`은 기본으로 KsponSpeech의 고정된 한국어 자유대화 샘플에서 Whisper 모델의 문자 오류율을 비교합니다. `--qwen`을 추가하면 설치된 로컬 Qwen도 함께 평가합니다. 예를 들어 `python3 scripts/evaluate-speech.py --corpus fleurs --qwen .speech/ggml-whisper-large-v3-turbo-korean-q5_0.bin`은 Google FLEURS 한국어 시험 세트의 첫 12개 낭독 음성(0~11번)을 두 모델로 전사합니다. Python 3과 ffmpeg가 필요합니다. 정답과 전사에서 문자와 숫자만 남긴 뒤 삽입·삭제·치환 횟수의 합을 정답 글자 수로 나눕니다. 숫자의 한글 표기와 아라비아 숫자 표기도 서로 다른 문자로 셉니다. `--openai`를 명시하면 선택한 공개 음성을 설정된 OpenAI API로 전송하며 사용료가 부과됩니다. [KsponSpeech 평가 자료](https://huggingface.co/datasets/yfyeung/ksponspeech-eval) · [Google FLEURS, Conneau 외, CC BY 4.0](https://huggingface.co/datasets/google/fleurs) · [한국어 Whisper 모델](https://huggingface.co/JoaoZaokk/whisper-large-v3-turbo-korean-ggml)

이 Mac에서 측정한 한국어 문자 오류율입니다. 같은 녹음과 정답을 사용했고 회의 용어나 이름에 대한 힌트는 주지 않았습니다.

| 평가 음성 | 한국어 Whisper | Qwen3-ASR 0.6B Q8 | Qwen3-ASR 1.7B Q4_K |
| --- | ---: | ---: | ---: |
| KsponSpeech 자유대화 24개, 474자 | 6.5% | 7.4% | 7.8% |
| FLEURS 낭독 12개, 539자 | 10.6% | 3.7% | 2.8% |

FLEURS에서 Qwen이 줄인 오류는 주로 날짜나 숫자의 표기 차이였습니다. 숫자가 없는 7개 녹음에서는 Whisper가 315자 중 6자, Qwen 1.7B가 7자를 틀렸습니다. 실제 회의 음성과 OpenAI 모델 점수는 이 표에 포함하지 않았습니다.
