// all-in-one.ts - 모든 코드를 하나의 파일에
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

// === 인터페이스 정의 ===
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
  total_count?: number;
  p_count?: number;
  response_time?: string;
  total_available_slots?: number;
  has_availability?: boolean;
}

// === Circuit Breaker 클래스 ===
class CircuitBreaker {
  private failure_threshold: number;
  private recovery_timeout: number;
  private failure_count: number = 0;
  private last_failure_time: number | null = null;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(failure_threshold: number = 5, recovery_timeout: number = 300) {
    this.failure_threshold = failure_threshold;
    this.recovery_timeout = recovery_timeout;
  }

  isAvailable(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (this.last_failure_time && Date.now() - this.last_failure_time > this.recovery_timeout * 1000) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failure_count = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failure_count++;
    this.last_failure_time = Date.now();
    if (this.failure_count >= this.failure_threshold) {
      this.state = 'OPEN';
    }
  }
}

// === 메인 크롤러 클래스 ===
class TennisCourtCrawler {
  private baseUrl = "https://yeyak.dobongsiseol.or.kr";
  private ajaxUrl: string;
  private indexUrl: string;
  private session: AxiosInstance;
  private cookieJar: CookieJar;
  private loggedIn = false;
  private circuitBreaker: CircuitBreaker;

  constructor() {
    this.ajaxUrl = `${this.baseUrl}/rent/ajax.day.rent.list_re.php`;
    this.indexUrl = `${this.baseUrl}/rent/index.php?c_id=05&page_info=index&n_type=rent&c_ox=0`;
    this.circuitBreaker = new CircuitBreaker(5, 600);
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

      const response = await this.session.post(this.ajaxUrl, new URLSearchParams(data), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': this.indexUrl,
        },
        timeout: 15000
      });

      let responseText = response.data;
      if (typeof responseText === 'string') {
        responseText = responseText.replace(/^\uFEFF/, '');
      }

      const result = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
      return this.parseAvailabilityData(dateStr, result);

    } catch (error: any) {
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
        console.log('파싱 오류');
      }
    }

    playData.forEach((courtInfo, i) => {
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
        courtData.time_slots = this.parseTimeSlots(courtInfo.htmlx);
      }

      courtData.available_slots = courtData.time_slots.filter(s => s.available).length;
      courtData.total_slots = courtData.time_slots.length;
      courtData.has_availability = courtData.available_slots > 0;
      result.courts.push(courtData);
    });

    const total = result.courts.reduce((sum, c) => sum + c.available_slots, 0);
    result.total_available_slots = total;
    result.has_availability = total > 0;

    return result;
  }

  private parseTimeSlots(htmlContent: string): TimeSlot[] {
    const $ = cheerio.load(htmlContent);
    const slots: TimeSlot[] = [];

    $('input[type="checkbox"]').each((_, element) => {
      const checkbox = $(element);
      const value = checkbox.attr('value') || '';
      const timeMatch = value.match(/(\d{1,2}):(\d{2})/);

      if (timeMatch) {
        let hour = parseInt(timeMatch[1]);
        const minute = timeMatch[2];
        if (hour === 6 && minute === "00") return;
        if (hour >= 7) hour -= 1;

        const isAvailable = !checkbox.attr('disabled');
        slots.push({
          time: `${hour.toString().padStart(2, '0')}:${minute}`,
          available: isAvailable,
          price: '',
          status: isAvailable ? 'available' : 'disabled'
        });
      }
    });

    return slots;
  }

  async crawlMonth(year: number, month: number, delay = 0.5): Promise<AvailabilityResult[]> {
    console.log(`${year}년 ${month}월 크롤링 시작...`);
    const dates = this.getMonthDates(year, month);
    const results: AvailabilityResult[] = [];

    for (let i = 0; i < dates.length; i++) {
      console.log(`진행: ${i + 1}/${dates.length} - ${dates[i]}`);
      const result = await this.checkAvailability(dates[i]);
      results.push(result);
      if (i < dates.length - 1) await this.sleep(delay * 1000);
    }

    return results;
  }

  private getMonthDates(year: number, month: number): string[] {
    const dates: string[] = [];
    const lastDay = new Date(year, month, 0).getDate();
    for (let day = 1; day <= lastDay; day++) {
      dates.push(`${year}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`);
    }
    return dates;
  }
}

// === 실행 코드 ===
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
  
  // 특정 날짜 조회
  console.log("\n특정 날짜 조회...");
  const result = await crawler.checkAvailability("20251015");
  console.log(JSON.stringify(result, null, 2));
  
  // 한 달 크롤링 (필요시 주석 해제)
   const results = await crawler.crawlMonth(2025, 10, 0.5);
   fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
   console.log("결과 저장 완료!");
}

main().catch(console.error);