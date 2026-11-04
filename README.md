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

## 매일 쓰는 법

| 누가 | 언제 | 할 일 |
|---|---|---|
| 에이미 | 아침 | **관리 → 담당 지정** 에서 그날 온 강아지 담당 고르기 (전날 담당 불러오기 가능) |
| 선생님들 | 수시로 | **올리기** 에서 찍은 사진 여러 장 선택 → 자동 분류 |
| 선생님들 | 알림장 쓸 때 | **내 사진** → 내 이름 → 강아지별 **저장** (폰은 사진 앱에 저장, PC는 zip) |
| 누구나 | 틈틈이 | **확인 필요** 에서 AI가 헷갈린 사진 직접 지정 |

### 처음 시작할 때
**관리 → 강아지 명단** 에서 강아지마다 이름, 특징(견종·털색·눈에 띄는 무늬), 기준 사진을 등록하세요.
기준 사진은 얼굴과 털색이 잘 보이는 정면 사진이 가장 좋아요. 자주 헷갈리는 아이는 기준 사진을 더 잘 나온 걸로 바꾸고 특징을 자세히 적으면 좋아져요.

---

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
