# 6단계 — 공유·이력·이미지 출력

선행 조건: [5단계](./05-postgresql-ddl-import.md) 완료. [공통 아키텍처](./00-scope-and-architecture.md)의 프로젝트 권한·revision 정책을 따른다.

## 목표와 범위

팀에서 사용할 수 있도록 프로젝트 멤버 관리, 서버 이력 확인·복원, PNG·SVG 출력을 제공한다. 공유는 로그인한 프로젝트 멤버에게 권한을 주는 방식이다. 공개 링크·익명 공유·실시간 공동 편집·메일 초대 발송은 초기 범위에 없다.

## 구현 작업

### 1. 멤버 관리와 조회 전용 편집기

- owner가 이미 가입한 사용자를 정확한 식별 정보로 찾아 프로젝트에 추가하고 role을 변경·회수하는 화면을 만든다. 사용자 검색은 owner만 사용할 수 있게 하고 반환 정보를 최소화한다.
- `GET/POST /api/projects/:projectId/members`, 멤버별 `PATCH/DELETE` 경로를 제공한다.
- owner/editor/viewer 역할을 UI와 서버에서 동일하게 적용한다. viewer도 읽을 수 있는 모델의 이미지·SQL export는 가능하다. SQL import·문서 수정·복원은 editor 이상만 가능하다.
- 마지막 owner를 제거하거나 viewer로 내리는 변경을 막는다. 동시 권한 변경에서도 owner 최소 한 명 조건을 트랜잭션으로 보장한다.
- viewer 편집기는 폼·단축키·드래그·삭제·undo 등 수정 경로를 모두 비활성화한다. 화면에서 막는 것과 별도로 API 권한을 검증한다.
- 권한이 회수된 사용자는 기존 세션·작업 ID·문서 URL로 계속 접근할 수 없어야 한다. 열린 편집기에서 실패를 알려주고 다른 사용자의 데이터로 복구본을 연결하지 않는다.
- 권한 회수 전에 이미 읽거나 다운로드한 데이터까지 원격 삭제할 수 있다고 안내하지 않는다.

### 2. 서버 버전과 복원

- 자동 저장 revision과 복원 가능한 snapshot을 구분해 표시한다.
- 이력 종류는 수동 snapshot, 주기 checkpoint, import 교체 전, 복원 전으로 구분한다. 작성자·시각·원본 revision·간단한 설명을 표시한다.
- 주기 checkpoint는 변경이 있을 때 문서당 기본 10분 간격 이하로 생성하고 최근 50개를 기본 보관한다. 수동·import 전·복원 전 snapshot은 이 자동 정리 대상에 포함하지 않는다.
- `GET /api/erds/:erdId/revisions`, `POST /api/erds/:erdId/revisions`, `GET /api/erds/:erdId/revisions/:snapshotId`, `POST .../:snapshotId/restore`를 제공한다.
- 과거 snapshot은 조회 전용으로 열고 현재 문서와 구별한다. 객체 수·이름 중심의 변경 요약은 제공할 수 있으나 SQL migration 생성으로 확대하지 않는다.
- 복원 전에 최신 저장을 확인하고 현재 revision으로 요청한다. 미저장 변경은 먼저 저장하거나 별도 복구본으로 보존한다.
- restore는 권한·snapshot 소속·base revision·형식 마이그레이션·구조 검증을 확인한다. 현재 문서 snapshot 생성과 과거 payload의 새 revision 저장을 한 트랜잭션에서 처리한다.
- 과거 revision 숫자로 되돌리지 않는다. 복원도 새로운 변경이므로 revision을 증가시킨다.
- restore 요청은 mutation ID로 멱등 처리한다. DB 실패·응답 유실·다른 클라이언트 수정에서 절반만 복원되면 안 된다.
- 복원 후 로컬 명령 이력을 초기화하고 새 서버 revision에 맞춰 복구본을 갱신한다.

### 3. PNG·SVG 출력

- 현재 뷰 전체 또는 선택한 테이블을 대상으로 출력 범위를 고를 수 있게 한다. 다른 뷰의 배치를 섞지 않는다.
- 화면에서 스크롤 밖에 있는 노드도 지정 범위에 포함한다. 현재 viewport의 screenshot만 저장하지 않는다.
- 출력 직전 뷰와 모델 snapshot을 고정한다. 렌더링 중 문서가 바뀌어 일부만 다른 revision이 되지 않게 한다.
- 표시 모드(논리/물리), 컬럼 접기·숨김, 메모·그룹 포함, 배경 유무, PNG 배율을 선택한다.
- SVG는 정적인 도형·텍스트·선으로 생성하는 전용 renderer를 기본으로 한다. 외부 script·원격 리소스·편집기 전체 DOM을 포함하지 않는다.
- PNG는 동일한 출력 모델을 래스터화한다. font 로드와 실제 텍스트 크기 측정 후 bounds를 계산해 한글·긴 이름이 잘리지 않게 한다.
- 외부 URL 폰트·이미지에 의존하지 않는다. 필요한 font를 번들에 포함하면 라이선스를 기록한다.
- 기본 PNG 상한은 한 변 4,096px와 총 16백만 pixel이다. 브라우저·메모리 한계를 고려해 구성 가능하게 하고, 초과 시 축소나 뷰 분리를 안내한다. 빈 이미지를 성공으로 다운로드하지 않는다.
- 선택 범위 밖으로 이어지는 관계선은 출력 미리보기에서 제외 정책을 표시한다. 이미지의 시각적 생략은 catalog 삭제와 구분한다.

### 4. 일상 사용성

- 기존 테이블을 바꾸지 않는 뷰 단위 정렬·grid 재배치를 제공한다. 배치 변경은 undo로 되돌릴 수 있게 한다.
- 검색 결과에서 테이블·컬럼으로 이동하고 일치 항목을 강조한다.
- 입력 중 단축키가 테이블 삭제·undo 같은 다른 동작을 실행하지 않게 한다.
- 삭제·교체·복원에서는 영향 범위를 명확히 보여준다. 기술 내부 식별자를 일반 사용자에게 선택 기준으로 요구하지 않는다.

## 검증

1. viewer가 UI·직접 API·기존 작업 ID를 통해 수정·복원·import할 수 없다.
2. owner 변경 경쟁에서 마지막 owner를 잃지 않는다. 프로젝트·문서·snapshot의 소속을 바꿔 요청해도 접근하지 못한다.
3. restore 성공·실패·재시도·충돌에서 문서와 이력이 일관되고 revision이 단조 증가한다.
4. 구형 형식 snapshot을 마이그레이션해 복원해도 현재 문서 ID·target·참조가 유효하다.
5. 모든 노드가 viewport 밖에 있는 경우, 긴 한글 이름, 접힌 컬럼, 자기 FK, 메모·그룹이 있는 경우 PNG·SVG를 실제 열어 육안 확인한다.
6. 큰 뷰·높은 배율·폰트 지연·출력 중 편집에서 실패를 알리고 잘못된 파일을 만들지 않는다.
7. 주기 snapshot의 보관 제한과 수동·교체 전 snapshot 보존이 구분된다.

### 검증 결과

2026-11-18 Docker의 PostgreSQL 17.12와 Chromium 156.0.8078.79에서 검증했다. 의존성 클린 설치, 운영 빌드, 타입 검사, lint, 기본 테스트 43개, 통합 테스트 13개가 통과했다.

| 기준 | 판정 | 확인 내용 |
| --- | --- | --- |
| 1. viewer와 권한 회수 | 통과 | 폼·드래그·단축키·가져오기·복원 차단과 viewer의 내보내기 권한을 확인했다. editor였을 때 받은 가져오기 작업 ID는 viewer가 된 뒤 사용할 수 없었다. 멤버 회수는 열린 편집기와 기존 문서·이력·작업 URL에 반영됐다. [API 검증](../tests/sharing-history.integration.test.ts), [브라우저 검증](../tests/sharing-history-browser.integration.test.ts) |
| 2. owner 경쟁과 소속 | 통과 | 두 owner가 동시에 자기 역할을 내리거나 탈퇴해도 한 명이 남았다. 다른 프로젝트의 멤버·문서·작업과 다른 문서의 스냅샷으로 경로를 바꾼 요청을 차단했다. [경쟁·소속 검증](../tests/sharing-history.integration.test.ts) |
| 3. 원자적 복원 | 통과 | 복원 취소 시 쓰기 요청을 보내지 않았다. DB 쓰기 실패로 스냅샷과 리비전이 함께 롤백됐으며, 성공 뒤 응답이 유실되어도 같은 mutation을 재시도해 원래 결과를 받았다. 동시 저장과 복원 중 한 건만 저장됐다. [복원 트랜잭션](../tests/sharing-history.integration.test.ts), [브라우저 검증](../tests/sharing-history-browser.integration.test.ts) |
| 4. 저장 형식 마이그레이션 | 통과 | 확장 배열을 생략한 형식 0 스냅샷을 현재 형식으로 열고 복원했다. 기존 문서 ID, SQL 대상, 컬럼·키·뷰 참조를 확인했으며 ID나 대상이 불일치한 버전은 차단했다. [마이그레이션 검증](../tests/sharing-history.integration.test.ts) |
| 5. 실제 PNG·SVG | 통과 | 모든 노드를 viewport 밖에 둔 상태에서 이미지 두 형식을 내려받아 Chromium에서 다시 열었다. 긴 한글과 기호, 컬럼 접기·숨김, 자기 참조 FK, 메모·그룹, 배경 투명도를 확인했다. 선택한 테이블 출력의 생략 관계도 확인했다. [출력 검증](../tests/diagram-image-browser.integration.test.ts) |
| 6. 출력 한도와 고정 시점 | 통과 | 높은 배율의 한 변 한도와 큰 뷰의 총 픽셀 한도를 각각 적용했다. 글꼴 응답 지연은 오류로 표시했다. 글꼴 대기 중 다른 탭에서 모델을 저장해도 원래 뷰 스냅샷만 출력됐다. [출력 실패 검증](../tests/diagram-image-browser.integration.test.ts) |
| 7. 체크포인트 보관 | 통과 | 변경 없는 저장과 간격 내 연속 저장은 체크포인트를 추가하지 않았다. 보관 수를 넘기면 최신 50개만 남고 수동·교체 전·복원 전 버전은 보존됐다. [간격·보관 검증](../tests/sharing-history.integration.test.ts), [가져오기 이력 회귀 검증](../tests/sql-import-jobs.integration.test.ts) |

## 완료 기준

- [x] 프로젝트 멤버 권한을 실제 관리하고 조회 전용 화면을 사용할 수 있다.
- [x] 수동 snapshot과 과거 버전 조회·원자적 복원이 동작한다.
- [x] 취소·실패·재시도에서 이력과 문서가 일관된다.
- [x] PNG·SVG의 범위·글자·관계선을 실제 출력물로 확인했다.
- [x] 외부 ERD 파일 호환·공개 익명 링크·실시간 공동 편집을 추가하지 않았다.

## 사용과 설정

- 기존 서비스 DB에는 `pnpm db:migrate`로 [6단계 마이그레이션](../db/migrations/004-sharing-history.sql)을 적용한다. 가입한 사용자가 **내 공유 코드**를 전달하면 프로젝트 owner가 **멤버 관리**에서 해당 계정을 확인해 추가한다. owner는 역할을 부여하거나 회수하며, 열린 편집기는 포커스 변경과 주기 확인으로 프로젝트 권한을 다시 확인한다. [멤버 API](../apps/api/src/project-members.ts)
- **버전 이력**은 자동 저장 리비전과 복원 가능한 스냅샷을 별도로 표시한다. 수동 저장은 설명과 기준 리비전을 받는다. 복원 성공 결과는 같은 mutation ID로 24시간 동안 재조회할 수 있다. 체크포인트는 내용이 바뀐 자동 저장에서만 문서당 기본 10분 간격으로 생성하며 최신 50개를 남긴다. `ERD_CHECKPOINT_INTERVAL_MS`와 `ERD_CHECKPOINT_KEEP`으로 조정할 수 있다. [버전 API](../apps/api/src/revisions.ts), [환경 예시](../.env.example)
- **이미지 내보내기**에서 범위, 물리명·논리명, 컬럼 표시, 메모·그룹, 배경, PNG 배율을 선택한다. 선택한 테이블과 같은 그룹의 메모·그룹을 포함할 수 있으며 범위 밖으로 이어지는 관계선은 생략한다. PNG 기본 한도는 한 변 4,096px와 1,600만 픽셀이다. 웹 실행·빌드 전에 `VITE_ERD_PNG_MAX_SIDE`와 `VITE_ERD_PNG_MAX_PIXELS`를 설정할 수 있다. [이미지 설정](../.env.example), [공통 이미지 렌더러](../apps/web/src/diagram-image.ts)
- 출력에는 Noto Sans KR의 400 weight에서 추린 한글·라틴 WOFF2를 사용한다. 브라우저는 앱에 포함된 글꼴을 불러오며, SVG에는 글꼴과 라이선스가 내장된다. [글꼴 라이선스](../apps/web/src/fonts/noto-sans-kr-OFL.txt), [원본 글꼴](https://github.com/google/fonts/tree/4efc2774c63917927efe769ca845def6bd6debae/ofl/notosanskr)

## 다음 단계와 개발 요청 예시

다음은 [7단계 안정화](./07-hardening-and-release.md)다.

> docs/README.md와 docs/00-scope-and-architecture.md를 읽고, docs/06-sharing-history-and-images.md의 6단계를 구현해줘. 프로젝트 권한·버전 복원의 경쟁 처리와 실제 PNG·SVG 출력까지 검증해줘.
