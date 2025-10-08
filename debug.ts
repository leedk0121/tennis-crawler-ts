// debug.ts - 디버깅 버전
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

interface TimeSlot {
  time: string;
  available: boolean;
  price: string;
  status: string;
}

interface CourtData {
  court_name: string;
  court_code: string;
  place_code: string;
  event_code: string;
  time_slots: TimeSlot[];
  available_slots: number;
  total_slots: number;
  has_availability: boolean;
}

interface AvailabilityResult {
  date: string;
  formatted_date?: string;
  status: string;
  error?: string;
  courts: CourtData[];
  total_available_slots?: number;
  has_availability?: boolean;
}

class TennisCourtCrawler {
  private baseUrl = "https://yeyak.dobongsiseol.or.kr";
  private ajaxUrl: string;
  private indexUrl: string;
  private session: AxiosInstance;
  private cookieJar: CookieJar;
  private loggedIn = false;

  constructor() {
    this.ajaxUrl = `${this.baseUrl}/rent/ajax.day.rent.list_re.php`;
    this.indexUrl = `${this.baseUrl}/rent/index.php?c_id=05&page_info=index&n_type=rent&c_ox=0`;
    this.cookieJar = new CookieJar();
    this.session = wrapper(axios.create({
      jar: this.cookieJar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      }
    }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async login(username: string, password: string): Promise<boolean> {
    const loginPage = "https://www.dobongsiseol.or.kr/contents/sso_login.php";
    
    try {
      console.log("로그인 중...");
      await this.session.get(loginPage, { timeout: 15000 });

      const payload = {
        returl: this.indexUrl,
        user_id: username,
        user_pass: password,
      };

      await this.session.post(loginPage, new URLSearchParams(payload), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": loginPage,
        },
        timeout: 20000,
        maxRedirects: 5
      });

      await this.session.get(this.indexUrl, { timeout: 15000 });
      this.loggedIn = true;
      console.log("✅ 로그인 성공!");
      return true;

    } catch (error: any) {
      console.log(`❌ 로그인 실패: ${error.message}`);
      return false;
    }
  }

  async checkAvailability(dateStr: string): Promise<AvailabilityResult> {
    const data = {
      c_id: '05',
      rdate: dateStr,
      rent_open_start_day: '23'
    };

    try {
      await this.session.get(this.indexUrl, { timeout: 10000 });

      console.log('\n=== API 요청 ===');
      console.log('URL:', this.ajaxUrl);
      console.log('Data:', data);

      const response = await this.session.post(this.ajaxUrl, new URLSearchParams(data), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': this.indexUrl,
        },
        timeout: 15000
      });

      // 원본 응답 저장
      console.log('\n=== 원본 응답 ===');
      console.log('Status:', response.status);
      console.log('Headers:', response.headers);
      
      let responseText = response.data;
      if (typeof responseText === 'string') {
        responseText = responseText.replace(/^\uFEFF/, '');
      }

      // 응답을 파일로 저장
      const debugDir = './debug';
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      fs.writeFileSync(`${debugDir}/response_${dateStr}.json`, JSON.stringify(responseText, null, 2));
      console.log(`\n📁 응답 저장: ${debugDir}/response_${dateStr}.json`);

      const result = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
      
      console.log('\n=== 파싱된 JSON ===');
      console.log('Keys:', Object.keys(result));
      console.log('Full result:', JSON.stringify(result, null, 2));

      // play_name 확인
      if (result.play_name) {
        console.log('\n=== play_name 정보 ===');
        console.log('Type:', typeof result.play_name);
        console.log('Value:', result.play_name);
        
        let playData = typeof result.play_name === 'string' ? JSON.parse(result.play_name) : result.play_name;
        console.log('Parsed play_name:', JSON.stringify(playData, null, 2));

        // 각 코트의 HTML 저장
        playData.forEach((court: any, index: number) => {
          if (court.htmlx) {
            fs.writeFileSync(`${debugDir}/court_${index}_${dateStr}.html`, court.htmlx);
            console.log(`\n📁 코트 ${index} HTML 저장: ${debugDir}/court_${index}_${dateStr}.html`);
            console.log('HTML 길이:', court.htmlx.length);
            console.log('HTML 미리보기 (처음 500자):\n', court.htmlx.substring(0, 500));
          }
        });
      }

      return this.parseAvailabilityData(dateStr, result);

    } catch (error: any) {
      console.error('❌ 오류:', error.message);
      return {
        date: dateStr,
        status: 'error',
        error: error.message,
        courts: []
      };
    }
  }

  private parseAvailabilityData(dateStr: string, data: any): AvailabilityResult {
    const result: AvailabilityResult = {
      date: dateStr,
      formatted_date: `${dateStr.slice(0, 4)}년 ${dateStr.slice(4, 6)}월 ${dateStr.slice(6, 8)}일`,
      status: 'success',
      courts: []
    };

    let playData: any[] = [];
    if (data.play_name) {
      try {
        playData = typeof data.play_name === 'string' ? JSON.parse(data.play_name) : data.play_name;
      } catch (e) {
        console.error('❌ play_name 파싱 오류:', e);
      }
    }

    console.log(`\n=== 코트 파싱 (총 ${playData.length}개) ===`);

    playData.forEach((courtInfo, i) => {
      console.log(`\n--- 코트 ${i + 1}: ${courtInfo.play_name} ---`);
      
      const courtData: CourtData = {
        court_name: courtInfo.play_name || `코트${i + 1}`,
        court_code: courtInfo.play_code || '',
        place_code: courtInfo.place_code || '',
        event_code: courtInfo.event_code || '',
        time_slots: [],
        available_slots: 0,
        total_slots: 0,
        has_availability: false
      };

      if (courtInfo.htmlx) {
        console.log('HTML 존재, 파싱 시작...');
        courtData.time_slots = this.parseTimeSlots(courtInfo.htmlx);
        console.log(`파싱된 시간대: ${courtData.time_slots.length}개`);
        
        if (courtData.time_slots.length > 0) {
          console.log('첫 3개 시간대:', courtData.time_slots.slice(0, 3));
        }
      } else {
        console.log('⚠️ htmlx 필드 없음');
      }

      courtData.available_slots = courtData.time_slots.filter(s => s.available).length;
      courtData.total_slots = courtData.time_slots.length;
      courtData.has_availability = courtData.available_slots > 0;
      
      console.log(`예약 가능: ${courtData.available_slots}/${courtData.total_slots}`);
      
      result.courts.push(courtData);
    });

    const total = result.courts.reduce((sum, c) => sum + c.available_slots, 0);
    result.total_available_slots = total;
    result.has_availability = total > 0;

    return result;
  }

  private parseTimeSlots(htmlContent: string): TimeSlot[] {
    console.log('\n  === parseTimeSlots 시작 ===');
    const $ = cheerio.load(htmlContent);
    const slots: TimeSlot[] = [];

    // checkbox만 찾기
    const checkboxes = $('input[type="checkbox"]');
    console.log(`  checkbox: ${checkboxes.length}개`);

    checkboxes.each((idx, element) => {
      const checkbox = $(element);
      const value = checkbox.attr('value') || '';
      const disabled = checkbox.attr('disabled');
      
      console.log(`\n  Checkbox ${idx + 1}:`);
      console.log(`    value: ${value}`);
      console.log(`    disabled: ${disabled}`);

      // 시간 찾기: checkbox의 부모 <ul>에서 .chk_t 클래스를 가진 형제 요소 찾기
      let timeText = '';
      const parentUl = checkbox.closest('ul');
      
      if (parentUl && parentUl.length > 0) {
        const timeElement = parentUl.find('li.chk_t');
        if (timeElement.length > 0) {
          timeText = timeElement.text().trim();
          console.log(`    시간 텍스트: ${timeText}`);
        }
      }

      // 시간 텍스트에서 시간 추출 (예: "08:00 ~ 09:00")
      const timeMatch = timeText.match(/(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/);
      
      if (timeMatch) {
        const startHour = parseInt(timeMatch[1]);
        const startMinute = timeMatch[2];
        
        console.log(`    시작 시간: ${startHour}:${startMinute}`);

        const isAvailable = !disabled;
        console.log(`    예약 가능: ${isAvailable}`);
        
        slots.push({
          time: `${startHour.toString().padStart(2, '0')}:${startMinute}`,
          available: isAvailable,
          price: '',
          status: isAvailable ? 'available' : 'disabled'
        });
      } else {
        console.log(`    ⚠️ 시간 정보를 찾을 수 없음 (텍스트: "${timeText}")`);
      }
    });

    console.log(`  === 총 ${slots.length}개 시간대 파싱 완료 ===\n`);
    return slots;
  }
}

// 실행 코드
async function main() {
  const crawler = new TennisCourtCrawler();
  
  // 여기에 실제 아이디/비밀번호 입력
  const username = "leedk0121";  // 🔴 변경 필요
  const password = "dookoung1!!";  // 🔴 변경 필요
  
  const loginSuccess = await crawler.login(username, password);
  if (!loginSuccess) {
    console.log("로그인 실패. 프로그램 종료.");
    return;
  }
  
  // 특정 날짜 조회 (오늘부터 일주일 후 날짜로 테스트)
  const testDate = "20251015"; // 테스트할 날짜
  console.log(`\n📅 테스트 날짜: ${testDate}`);
  
  const result = await crawler.checkAvailability(testDate);
  
  console.log('\n\n=== 최종 결과 ===');
  console.log(JSON.stringify(result, null, 2));
  
  // 결과를 파일로 저장
  fs.writeFileSync('./debug/final_result.json', JSON.stringify(result, null, 2));
  console.log('\n📁 최종 결과 저장: ./debug/final_result.json');
  
  console.log('\n\n=== 디버그 파일 확인 ===');
  console.log('./debug/ 폴더를 확인하세요:');
  console.log('  - response_*.json: 서버 원본 응답');
  console.log('  - court_*_*.html: 각 코트의 HTML');
  console.log('  - final_result.json: 최종 파싱 결과');
}

main().catch(console.error);