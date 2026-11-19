# 운영 가이드

## 패키지 실행

Docker와 Compose V2에서 다음 명령을 실행합니다. 기본 주소는 `http://127.0.0.1:8080`입니다. `db`는 PostgreSQL 17.12, `migrate`는 일회성 마이그레이션, `api`는 서비스, `web`은 정적 파일과 같은 origin의 `/api`를 제공합니다.

```sh
docker compose up -d --build --wait
docker compose ps -a
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/ready
```

로컬 포트를 바꿀 때는 `HERD_HTTP_PORT`와 `APP_ORIGIN`의 포트를 함께 바꿉니다. 소스 개발 흐름에서는 `docker compose up -d --wait db`로 DB만 시작하고 호스트에서 `pnpm db:migrate`와 `pnpm dev`를 실행합니다. Compose 네트워크의 DB 주소는 `db:5432`, 호스트 포트 기본값은 `127.0.0.1:55432`입니다. 호스트 개발용 `.env`를 이미 사용 중이면 전체 스택 실행에는 Compose 전용 `--env-file`에 맞는 DB 주소와 origin을 지정합니다. 서비스 데이터는 `herd-db` 볼륨에 저장됩니다. `docker compose down`은 해당 볼륨을 보존합니다.

운영값은 접근을 제한한 환경 파일이나 배포 환경의 시크릿으로 공급합니다. 호스트의 HTTPS 프록시가 앱으로 들어오는 요청을 loopback 웹 포트로 전달하게 설정합니다. 패키지는 동일 origin의 웹과 API를 제공하며, OIDC callback에 쓰는 공개 주소는 `APP_ORIGIN`에서 정합니다.

| 설정 | 운영 값과 기본 동작 |
| --- | --- |
| `HERD_NODE_ENV`, `HERD_DEV_LOGIN` | Compose 운영값은 `production`과 `0`입니다. 자체 실행은 각각 `NODE_ENV`, `ERD_DEV_LOGIN`을 사용합니다. |
| `HERD_LOCAL_AUTH` | `1`이면 HERD 자체 계정 가입과 로그인을 켭니다. 자체 실행은 `ERD_LOCAL_AUTH=1`을 사용합니다. |
| `APP_ORIGIN` | 브라우저가 여는 HTTPS origin 전체입니다. 경로를 빼고 스킴과 호스트, 필요한 포트를 포함합니다. 쓰기 요청의 Origin과 CSRF 토큰을 확인합니다. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OIDC 로그인을 사용할 때 HTTPS issuer와 기밀 클라이언트 자격 증명을 설정합니다. 공급자에 `<APP_ORIGIN>/api/auth/callback`을 등록합니다. |
| `DATABASE_URL` | 서비스 테이블을 읽고 쓰는 DB 계정입니다. URL의 자격 증명에는 퍼센트 인코딩을 적용합니다. 운영의 원격 DB는 검증 가능한 TLS 구성을 사용합니다. |
| `HERD_MIGRATION_DATABASE_URL`, `HERD_DB_PASSWORD` | 마이그레이션 계정을 분리할 수 있습니다. 번들 DB의 초기 비밀번호와 접속 URI는 함께 설정합니다. 이미 초기화한 볼륨의 비밀번호는 DB에서 변경합니다. |
| `API_HOST`, `API_PORT`, `HERD_HTTP_PORT`, `HERD_DB_PORT` | API 자체 실행 기본은 `127.0.0.1:3001`입니다. Compose API는 내부 네트워크를 사용합니다. 호스트에는 웹·DB의 loopback 포트만 게시합니다. |
| `ERD_MAX_DOCUMENT_BYTES`, `ERD_MAX_TABLES`, `ERD_MAX_COLUMNS`, `ERD_MAX_RELATIONSHIPS` | 문서 JSON 20 MiB, 테이블 1,000개, 컬럼 20,000개, FK와 논리 관계 합계 5,000개가 기본값입니다. |
| `SQL_JOB_MAX_INPUT_BYTES`, `SQL_JOB_TIMEOUT_MS`, `SQL_JOB_TTL_MS` | UTF-8 SQL 5 MiB, worker 실행 10초, 결과 보관 10분이 기본값입니다. API JSON envelope와 Nginx 32 MiB 요청 한도도 용량을 조정할 때 함께 확인합니다. |
| `SQL_JOB_WORKERS`, `SQL_JOB_USER_LIMIT`, `SQL_JOB_MAX_ACTIVE` | 동시 worker 2개, 사용자당 대기·실행 합계 2개, 서비스 전체 64개가 기본값입니다. |
| `SQL_WORKER_HEAP_MB`, `HERD_API_MEMORY_LIMIT` | 작업별 자식 프로세스의 V8 old generation은 기본 256 MiB입니다. WASM linear memory에도 256 MiB 상한을 둡니다. Compose API 메모리 예산은 기본 1,536 MiB이며 API와 자식 프로세스의 실제 사용량을 합산합니다. |
| `ERD_CHECKPOINT_INTERVAL_MS`, `ERD_CHECKPOINT_KEEP` | 변경이 있는 저장의 스냅샷 간격 10분과 문서별 최근 50개를 기본으로 사용합니다. |
| `VITE_ERD_PNG_MAX_SIDE`, `VITE_ERD_PNG_MAX_PIXELS` | 웹 빌드 시 PNG 한 변 4,096px, 총 16,000,000px를 기본 적용합니다. |

운영 쿠키는 `__Host-` 접두어, `Secure`, `HttpOnly`, `SameSite=Lax`를 사용합니다. OIDC와 서비스 DB는 앱의 인증·저장 인프라입니다. 편집기의 PostgreSQL 17 target은 설계 모델과 DDL에 적용됩니다. [환경 예시](../.env.example), [Compose 구성](../compose.yaml)

자체 계정 모드를 사용하면 루트 주소에서 로그인과 가입을 제공하고 로그인 후 내가 만든 프로젝트를 먼저 표시합니다. 비밀번호는 사용자별 솔트와 scrypt 해시로 저장합니다. 가입과 로그인 요청에는 만료되는 DB 카운터를 적용합니다. OIDC와 개발 계정의 사용자 ID는 각자의 기존 식별자를 사용합니다.

웹 컨테이너가 직접 HTTPS를 제공할 때는 [TLS 설정](../deploy/herd-tls.conf)을 `/etc/nginx/herd-tls/herd.conf`에 마운트합니다. 인증서와 키는 `/etc/nginx/herd-cert/server.crt`와 `/etc/nginx/herd-cert/server.key`에 마운트하고 웹 컨테이너의 실행 사용자가 읽을 수 있게 지정합니다. 웹의 게시 포트는 TLS 포트 `8443`에 연결하고 `APP_ORIGIN`을 브라우저가 접속하는 HTTPS 주소와 일치시킵니다. IP로 접속할 때는 인증서에 IP SAN을 추가하고 접속 기기에 신뢰 인증서를 배포합니다.

## 버전별 릴리스

Git 태그를 릴리스 버전으로 사용합니다. `v0.1.0`부터 시작하며, 다음 릴리스에서는 검증한 커밋에 원하는 버전의 태그를 붙이고 같은 버전으로 패키지를 만듭니다.

```sh
git tag -a v0.1.1 -m v0.1.1
sh scripts/release.sh v0.1.1 linux/amd64
```

서버가 ARM64이면 `linux/arm64`를 지정합니다. 플랫폼을 생략하면 Docker 데몬의 기본 플랫폼으로 빌드합니다. 태그가 가리키는 커밋에서 웹과 API를 빌드하고, 두 이미지에 버전과 커밋 SHA를 기록합니다. API와 마이그레이션은 같은 이미지를 사용합니다.

`build/releases/v0.1.1-linux-amd64/`에 `images.tar.gz`, `compose.yaml`, `release.env`, `release.txt`가 생성됩니다. 패키지 디렉터리와 운영 환경 파일을 서버에 복사한 뒤 다음 명령을 실행합니다.

```sh
docker image load -i images.tar.gz
docker compose --env-file /path/to/production.env --env-file release.env pull db
docker compose --env-file /path/to/production.env --env-file release.env up -d --no-build --pull never --wait
curl -fsS http://127.0.0.1:8080/api/ready
```

`release.env`는 앱 이미지 버전과 기본 Compose 프로젝트 이름 `herd`를 지정합니다. 다음 버전에서도 같은 프로젝트 이름을 사용하면 기존 DB 볼륨을 이어서 사용합니다. 기존 배포를 교체할 때는 아래 마이그레이션 순서에 따라 이전 API를 중지하고 백업한 뒤 새 버전을 시작합니다.

## 준비 상태와 마이그레이션

- `GET /api/health`는 HTTP 프로세스의 생존을 확인합니다. `GET /api/ready`는 DB와 해당 빌드의 마이그레이션 이름·체크섬, SQL 작업 초기화를 확인합니다. DB가 비어 있거나 접속이 실패하거나 적용 이력이 다르면 503입니다. 트래픽 투입 기준은 readiness입니다.
- Compose는 DB 준비 뒤 `migrate`를 실행하고 성공한 뒤 API를 시작합니다. 독립 실행에서는 운영 빌드에서 `node dist/api/migrate.js`를 사용합니다. 마이그레이션은 서비스 DB 잠금을 잡고 적용하며, 이미 적용한 SQL 파일의 체크섬을 확인합니다.
- SQL 작업 큐는 서비스 DB당 API 한 인스턴스를 전제로 합니다. 교체는 이전 API 중지, 백업, 마이그레이션 적용, 새 API 시작, readiness 확인 순서로 진행합니다. 자체 프로세스 관리자에서는 API와 자식 프로세스를 같은 종료 그룹에 둡니다.

## 백업과 복원

서비스 DB는 PostgreSQL custom archive로 백업합니다. 아래 예제는 번들 DB를 사용합니다. 백업에는 활성 세션 해시와 TTL 안의 작업 데이터도 포함되므로 접근 권한과 보관 기간을 함께 관리합니다. 복원 테스트는 비어 있는 별도 DB에서 진행합니다.

```sh
umask 077
docker compose exec -T db pg_dump -U herd -d herd -Fc --no-owner --no-acl > herd-service.dump
docker compose exec -T db createdb -U herd herd_restore
docker compose exec -T db pg_restore -U herd -d herd_restore \
  --exit-on-error --single-transaction --no-owner --no-privileges < herd-service.dump
```

복원 DB에 테스트용 API를 연결해 readiness, 멤버의 role, ERD payload와 리비전, 스냅샷을 확인합니다. 분리된 운영 계정은 복원 뒤 소유권과 권한을 다시 구성합니다. 실제 복구로 전환할 때는 세션과 로그인 상태 토큰을 만료시키고, 로그인과 권한을 다시 확인합니다. 편집기의 DDL 내보내기는 설계 스키마를 전달하는 기능입니다. [백업 복원 검증](release-validation.md#운영-검증)

## 정리와 로그

| 데이터 | 보관과 정리 |
| --- | --- |
| SQL 작업 | 완료·실패·취소 결과의 기본 TTL은 10분입니다. 종료 상태가 되면 원본 분석 입력과 생성용 스냅샷을 제거합니다. API가 다시 시작되면 대기·실행 중 작업을 실패로 전환하고 새 작업을 요청할 수 있게 합니다. |
| 저장·스냅샷·복원·가져오기 멱등 결과 | 기본 TTL은 24시간입니다. HTTP 응답을 받지 못했을 때 같은 mutation ID와 요청을 보내면 보관된 성공 결과를 돌려줍니다. |
| 세션과 로그인 시도 | 세션은 7일, OIDC 로그인 시도는 10분입니다. 판정 시각에 만료된 토큰은 거부합니다. |
| 자동 체크포인트 | 저장 트랜잭션에서 문서별 간격과 보관 수를 적용합니다. |
| 수동·교체 전·복원 전 스냅샷 | 프로젝트의 이력으로 계속 보관합니다. 삭제 계획을 세울 때는 먼저 서비스 백업을 만든 뒤 프로젝트 소유자와 보존 대상과 범위를 확인합니다. |

API 시작 시와 이후 `min(SQL_JOB_TTL_MS, 60000)` 간격에 만료 작업·mutation·세션·로그인 상태를 정리합니다. DB가 일시 중단된 동안 실패한 정리는 다음 주기에 재시도됩니다. 스냅샷 사용량은 아래 쿼리로 관측할 수 있습니다.

```sql
SELECT kind, count(*) AS versions, pg_size_pretty(sum(pg_column_size(payload))) AS payload_bytes
FROM erd_revisions GROUP BY kind ORDER BY kind;

SELECT pg_size_pretty(pg_total_relation_size('erd_revisions')) AS history_storage;
```

운영 API 로그는 요청 ID, 고정 경로, 상태, 시간, 오류 코드와 SQL 작업 ID를 담습니다. 각 작업의 입력 SQL·출력·문서 본문·쿠키·토큰은 저장·변환용으로만 사용합니다. 웹 프록시는 HTTP access log를 끕니다.

## 장애와 롤백

1. readiness가 503이면 DB 연결과 적용 체크섬을 확인합니다. liveness만 정상이면 서버는 살아 있으며 DB 연결이 회복되면 다시 확인합니다.
2. 저장 응답을 잃었으면 같은 리비전과 mutation ID를 재시도합니다. 편집기에서 서버 버전과 충돌하면 서버 최신본 또는 내 변경을 새 문서로 복제하는 방법을 선택합니다.
3. API 재시작·timeout 뒤 SQL 작업을 다시 제출합니다. 인증이 만료됐으면 같은 계정으로 다시 로그인한 뒤 브라우저 복구본을 엽니다.
4. 이전 앱으로 되돌릴 때는 해당 이미지와 호환되는 마이그레이션 이력·문서 형식을 확인합니다. 신규 마이그레이션이나 문서 형식이 저장됐다면 이전 릴리스 시점 백업을 별도 DB에 복원하고 그 이미지로 검증한 뒤 전환합니다. 이후 생긴 변경은 전환 전에 대조합니다.

운영 구성의 자동화와 확인된 범위는 릴리스 검증 문서에 기록합니다. [릴리스 검증 기록](release-validation.md)
