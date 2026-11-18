# PostgreSQL MVP 릴리스 검증

검증일은 2026-11-19입니다. PostgreSQL 17 지원 범위 안에서 모델·DDL·서버 저장과 패키지 설치를 검증했습니다. [인증 프로필](sql-support/postgresql.md), [7단계 완료 기준](07-hardening-and-release.md)

## 재현 방법

```sh
docker build --target verify -t herd-verify .
docker run --rm herd-verify pnpm audit
docker run --rm --network none -e CI=1 herd-verify sh -ec '
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm test:integration
  pnpm build
  pnpm test:release
'
sh scripts/release-compose.sh
```

성능 테스트는 측정값을 표준 출력과 컨테이너의 `build/release/performance.json`에 기록합니다. 파일을 보존하려면 테스트 컨테이너를 이름으로 실행하고 종료 후 `docker cp`로 복사합니다. `HERD_IMAGE_REVIEW_DIR`을 지정하면 브라우저가 내려받은 PNG·SVG와 렌더링 화면도 지정한 경로에 저장합니다. [CI 워크플로](../.github/workflows/verify.yml)

## 검사 결과

| 기준 | 결과와 확인 내용 |
| --- | --- |
| 설치·정적 검사·빌드 | lockfile 클린 설치, TypeScript, ESLint, 웹·API·마이그레이션·SQL worker 빌드 통과 |
| 도메인과 브라우저 기본 검사 | 43개 통과. 참조 무결성·형식·명령·식 의존성·실행 취소·로컬 복구를 확인 |
| PostgreSQL 통합 | 13개 통과. 인증·프로젝트와 문서 권한·리비전 경쟁·멱등성·복원·SQL job 수명과 이전 버전 이력·이미지를 확인 |
| 운영 빌드 릴리스 검사 | 4개 통과. 실제 복원·준비 상태·프로세스 재시작·입력 경계, 두 규모의 측정, DDL 가져오기부터 복원·OIDC 재로그인까지 확인 |
| SQL 의미 | PostgreSQL 17.12의 원본·재생성 catalog, 실제 스키마 덤프, 모델→SQL→모델 비교, 전체·부분 스크립트 적용과 FK 동작을 확인 |
| 시각 검증 | Chromium에서 관계선·테이블·속성 패널·한글을 확인하고 다운로드한 PNG·SVG를 다시 열어 텍스트, 자기 참조 FK, 메모·그룹과 캔버스 밖 노드를 확인 |
| 의존성 감사 | Fastify 5.12.8, Zod 4.6.7, Vite 7.3.8, Vitest 4.1.12, typescript-eslint 8.73.0으로 공개 권고의 수정 버전을 반영한 뒤 `pnpm audit`에서 알려진 취약점 0건을 확인 |

| 사용자 흐름 | 검증 근거 |
| --- | --- |
| 로그인, 프로젝트·ERD 생성, 관계 편집과 자동 저장 | [프로젝트 브라우저](../tests/projects-browser.integration.test.ts), [캔버스 편집](../tests/erd-editor.browser.test.ts) |
| DDL 분석·경고 확인·새 ERD 적용·컬럼 편집·DDL 다운로드 | [운영 빌드 브라우저](../tests/workflow.release.test.ts) |
| 기존 ERD 교체·교체 전 버전 열기·복원 | [운영 빌드 브라우저](../tests/workflow.release.test.ts), [이력 API](../tests/sharing-history.integration.test.ts) |
| editor/viewer 추가, 조회 전용 조작과 기존 URL·작업 권한 회수 | [멤버 API](../tests/sharing-history.integration.test.ts), [멤버 브라우저](../tests/sharing-history-browser.integration.test.ts) |
| 두 탭 충돌, 내 변경 복제 후 계속 편집 | [프로젝트 브라우저](../tests/projects-browser.integration.test.ts) |
| 오프라인 복구·재연결과 만료 세션 재로그인 복구 | [프로젝트 브라우저](../tests/projects-browser.integration.test.ts), [운영 빌드 브라우저](../tests/workflow.release.test.ts) |

재연결 직후 저장 요청이 일시 실패하는 경우를 재현했습니다. 격리된 Chromium은 loopback HTTP가 회복된 뒤에도 온라인 신호를 보내지 않았습니다. 편집기는 같은 mutation을 간격을 두어 최대 세 번 더 보내 실제 저장 응답으로 연결을 확인합니다.

PostgreSQL 검증에는 모델→SQL→모델 왕복, 전체·부분 SQL 실행과 실제 덤프 가져오기가 포함됩니다. 분석은 AST와 임시 후보 catalog에서 수행하며 고정 식별자 fixture로 서비스 DB 격리를 확인했습니다. [전체·부분 생성](../tests/ddl-export.integration.test.ts), [덤프 가져오기](../tests/ddl-import.integration.test.ts), [SQL 변환 왕복](../tests/ddl-import.test.ts), [서비스 DB 격리](../tests/sql-import-jobs.integration.test.ts)

## 성능과 용량

Apple M5 Pro, 호스트 RAM 24 GiB, macOS 27.2.1에서 Docker의 Debian 12 arm64 VM에 노출된 4 vCPU와 7,923.5 MiB를 사용했습니다. Chromium 156.0.8078.79, Node 24.12.0, pnpm 10.11.0, PostgreSQL 17.12입니다. 웹은 Vite preview가 운영 빌드 자산을 제공했고, API는 컴파일된 엔트리, DB는 독립 테스트 클러스터였습니다. 브라우저와 웹·API·DB는 모두 동일 컨테이너의 loopback을 사용했습니다.

| fixture | 테이블 / 컬럼 / FK / 뷰 | JSON bytes | 생성 SQL bytes |
| --- | --- | ---: | ---: |
| 일반 | 100 / 2,000 / 150 / 3 | 510,475 | 107,596 |
| 큰 모델 | 300 / 6,000 / 600 / 3 | 1,581,225 | 344,194 |

| 관측값 | 일반 | 큰 모델 |
| --- | ---: | ---: |
| 첫 열기 3회, 캐시 끔 | 875 / 884 / 903 ms | 882 / 882 / 885 ms |
| 검색 이동·컬럼 강조 | 143 ms | 1,209 ms |
| 노드 드래그 | 162 ms | 1,023 ms |
| 컬럼 수정 후 화면 반영 | 118 ms | 1,011 ms |
| 저장 HTTP 왕복 / 편집부터 저장 완료 | 30 / 1,146 ms | 69 / 1,239 ms |
| DDL 생성 / 가져오기 분석 | 115 / 119 ms | 190 / 237 ms |
| 생성과 겹친 health / 문서 읽기 | 9 / 25 ms | 2 / 44 ms |
| 브라우저 JS heap / 첫 화면 렌더 노드 | 12.1 MiB / 100 | 12.4 MiB / 20 |
| 분석 완료 후 API RSS | 140.1 MiB | 237.6 MiB |
| 8개 테이블 상세 뷰의 PNG 미리보기 | 153 ms | 해당 없음 |

열기 시간은 이동부터 첫 노드가 보이는 시점과 두 프레임까지 포함합니다. 일반 3초, 큰 모델 8초, 일반 저장 2초, SQL 작업 10초 목표를 통과했습니다. 테이블 배치가 120개 이상인 뷰는 현재 viewport에서 필요한 노드만 렌더링합니다. 접힌 컬럼을 유지하고 컬럼 배지·FK를 인덱스로 조회합니다. 대형 모델의 검색·드래그·컬럼 반영은 각각 약 1초 걸렸습니다. 분석 후 부모 API RSS는 작업 프로세스를 분리하기 전 1,146 MiB에서 최종 측정 237.6 MiB로 감소했습니다. RSS는 완료 후 부모 프로세스 표본이고 브라우저 수치는 렌더러의 JS heap 표본입니다. [결정적 seed](../packages/test-fixtures/src/scale.ts), [측정 코드](../tests/performance.release.test.ts)

| 한도 검증 | 결과 |
| --- | --- |
| UTF-8 SQL 5,242,880 bytes | 242 ms에 분석 완료. 1 byte 초과는 39 ms에 413 |
| JSON 문서 20,971,520 bytes | 323 ms에 저장. 1 byte 초과는 128 ms에 413 |
| 테이블 1,000개·컬럼 20,000개·FK 5,000개 | 223 ms에 저장. 각 항목 1개 초과 요청은 83 / 78 / 81 ms에 413 |
| SQL 대기 상한, 격리와 취소 | 총 활성 작업 상한을 1로 설정한 다음 넘치는 요청을 429로 반환. 분석 중 health·최대 catalog 읽기·취소가 응답했고 취소한 입력을 지웠음 |
| CPU·메모리 제한 | 5 ms timeout 설정과 4 MiB worker heap 설정으로 실패를 유도해 작업을 종료하고 API가 계속 응답하는 것을 확인. 기본 제한으로는 일반·대형 모델 작업이 모두 완료 |

입력 경계 수치는 loopback 요청과 완료 응답을 측정한 값입니다. 최대 catalog 저장은 저장 형식의 경계를 확인합니다. [한도와 분리 검증](../tests/operations.release.test.ts)

## 운영 검증

- digest로 고정한 PostgreSQL 17.12에서 빈 DB 상태의 liveness 200과 readiness 503을 확인했습니다. 마이그레이션 적용·재실행, 체크섬 불일치 차단과 DB 재시작 후 readiness 회복을 검증했습니다.
- 임시 Compose 프로젝트의 네트워크와 볼륨으로 웹·API를 빌드했습니다. 마이그레이션 완료 후 API와 웹이 준비됐고 정적 자산 제공, 개발 로그인, 가져오기 분석과 적용, 스냅샷 저장, 생성 SQL 작업을 실제 HTTP로 확인했습니다. 검증이 끝난 임시 프로젝트의 컨테이너와 볼륨을 정리했습니다. [Compose 검증 스크립트](../scripts/release-compose.sh)
- 서비스 DB의 custom dump를 비어 있는 별도 DB에 `pg_restore`로 넣었습니다. 복원한 DB에 빌드된 API를 연결해 멤버 역할, 원본·최신 ERD와 이력, 리비전 2, 저장 mutation 재응답을 비교했습니다. 활성 문서와 과거 스냅샷의 형식 0 전환 및 알 수 없는 미래 형식에 대한 오류도 확인했습니다.
- 운영 로그에서 요청·작업 ID, 상태·시간과 오류 코드를 확인했습니다. 테스트 SQL·문서·세션·CSRF·OIDC 값이 로그에 나타나는지 검사했고, 만료 데이터 정리도 확인했습니다. [운영 검사](../tests/operations.release.test.ts)

## 남은 제한

OIDC 브라우저 검증에는 모의 공급자를 사용했습니다. 배포 환경에서는 운영 공급자와 HTTPS origin의 조합을 확인해야 합니다. 성능 수치는 단일 VM의 loopback 관측값입니다. SQL 지원 범위는 PostgreSQL 17 문서에 기록했습니다. CI 워크플로의 명령은 로컬 Docker에서 검증했으며, 호스팅된 실행 기록은 워크플로를 저장소에 게시한 뒤 생성됩니다. [운영 가이드](operations.md), [PostgreSQL 지원 범위](sql-support/postgresql.md)
