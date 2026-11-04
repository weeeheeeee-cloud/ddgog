# 댕겨올개 사진함

선생님들이 찍은 사진을 올리면 AI가 강아지별로 분류하고, 각 선생님은 자기 담당 강아지 사진만 모아서 보고 저장하는 웹앱입니다.

- **화면**: GitHub Pages (무료 호스팅)
- **사진·데이터·로그인**: Supabase
- **강아지 판별**: Claude API (Supabase Edge Function 안에서 호출)

---

## 처음 설치 (한 번만, 30분 정도)

### 1. Supabase 프로젝트 만들기
1. https://supabase.com 가입 → **New project** (Region: Northeast Asia (Seoul))
2. 왼쪽 메뉴 **SQL Editor** → `supabase/setup.sql` 내용을 전부 붙여넣고 **Run**
3. **Authentication → Sign In / Providers** 에서 **Allow new users to sign up 끄기** ⚠️ 꼭 꺼주세요. 켜져 있으면 링크를 아는 누구나 가입할 수 있어요.
4. **Authentication → Users → Add user** 로 직원 계정 만들기
   - 공용 계정 하나(예: staff@댕겨올개 이메일)로 다 같이 써도 되고, 선생님별로 만들어도 돼요.

> 이미 예전 setup.sql 을 실행했다면 `supabase/update-auto-groups.sql` 도 한 번 실행하세요. (자동 그룹·합치기 기능)

### 2. Claude API 키 발급
1. https://console.anthropic.com 가입 → 결제 수단 등록 → **API Keys → Create Key**
2. Supabase **Edge Functions → Secrets** 에 추가
   - 이름: `ANTHROPIC_API_KEY` / 값: 발급받은 키

### 3. 분류 함수 배포
Supabase **Edge Functions → Deploy a new function → Via Editor**
- 함수 이름: `classify` (정확히 이 이름)
- `supabase/functions/classify/index.ts` 내용을 붙여넣고 **Deploy**

### 4. 화면 연결
`config.js` 를 열어서 두 값을 바꿔주세요. (Supabase **Project Settings → API**)
```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";   // anon public 키
```

### 5. GitHub Pages 로 올리기
1. GitHub 에서 새 저장소 만들기 (예: `daenggyeolgae-photos`)
2. 이 폴더 파일을 전부 업로드 (**Add file → Upload files**)
3. **Settings → Pages → Branch: main / (root) → Save**
4. 1~2분 뒤 `https://<깃허브아이디>.github.io/daenggyeolgae-photos/` 링크가 생겨요 → 선생님들께 공유

> 폰에서 링크를 열고 **홈 화면에 추가**하면 앱처럼 쓸 수 있어요.

---

## 쓰는 법

### 오늘 출석 (선택, 하면 더 정확해요)
1. **사진** 탭 맨 위 **출석 보드 사진 올리기** → AI가 이름을 읽어 명단 초안을 만들어요
2. 이름이 맞는지 확인 (누르면 수정, ×로 빼기, 빠진 이름 추가) → **명단 확정**
3. 처음 보는 아이만 **대표 사진 올리기**가 떠요. 한 번 올린 얼굴은 계속 기억해서 다음부터는 ✓로 넘어가요.
4. AI가 만든 "새 강아지" 그룹에 명단 속 이름을 붙이면 자동으로 합쳐지고, 그 얼굴도 기억해요.

### 사진 분류
설정 없이 바로 쓰면 돼요.

1. **사진** 탭에서 **사진 올리기** → 여러 장 선택
2. AI가 한 장씩 보면서 같은 강아지끼리 묶어요. 처음 보는 아이는 **새 강아지 1, 2, 3…** 그룹이 자동으로 생겨요.
3. 그룹 이름(✎)을 눌러 이름 붙이기 → 다음부터 그 이름으로 분류돼요.
4. 그룹 오른쪽 **저장** → 폰은 사진 앱에 저장, PC는 zip
5. 맨 아래 **분류 안 된 사진**은 눌러서 강아지를 고르거나 **새 강아지로** 만들기
6. 잘못 분류된 사진도 눌러서 바로 고칠 수 있어요.

**관리** 탭: 같은 아이가 두 그룹으로 나뉘면 **합치기**, 기준 사진 바꾸기, 오래된 사진 정리, 전체 초기화

> 분류는 같은 아이가 중복 그룹으로 생기지 않도록 한 장씩 차례로 진행돼요. 분류 중에는 창을 닫지 마세요. 닫았다면 다시 열고 **남은 N장 분류하기**를 누르면 이어서 해요.

## 비용·용량 참고
- 분류는 사진 1장마다 Claude API 를 한 번 호출해요. 비용을 줄이려고 분류용 사진은 640px로 줄여 보내고, 그날 강아지 기준 사진 묶음은 캐시되도록 해 두었어요. 첫 며칠은 Anthropic 콘솔의 **Usage** 에서 하루 사용액을 꼭 확인해 보세요. 콘솔에서 월 사용 한도도 걸어둘 수 있어요.
- 사진은 1600px 로 줄여서 저장돼요 (알림장용으로 충분한 화질). 하루 900장이면 저장 공간이 빨리 차니 **관리 → 오래된 사진 정리** 로 주기적으로 지워주세요. Supabase 무료 플랜은 저장 공간이 크지 않아서, 오래 보관하려면 유료 플랜이 필요할 수 있어요.
- 분류 모델을 바꾸고 싶으면 Edge Function Secrets 에 `CLASSIFY_MODEL` 을 추가하세요. (기본: `claude-haiku-5-5`, 더 정확하게: `claude-sonnet-5-5`)

## 파일 구조
```
index.html / style.css / app.js / config.js   화면 (GitHub Pages)
supabase/setup.sql                             DB·저장소 설정
supabase/functions/classify/index.ts           강아지 판별 함수
```
