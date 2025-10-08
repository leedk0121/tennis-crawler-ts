// nowon-crawler.ts - 노원구 체육시설 예약 크롤러
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as https from 'https';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

interface TimeListResponse {
  useBeginHour: number;
  hourUnit: number;
  line: string;
}

interface ReservedItem {
  cseq?: number | string;
  useTimeBegin?: string;
}

interface CheckReserveResponse {
  list?: ReservedItem[];
}

interface CrawlRow {
  date: string;
  court: string;
  startTime: string;
  endTime: string;
  status: string;
}

interface MonthResults {
  bul: CrawlRow[];
  ma: CrawlRow[];
  cho: CrawlRow[];
}

class NowonCrawler {
  private baseUrl = "https://reservation.nowonsc.kr";
  private session: AxiosInstance;
  private cookieJar: CookieJar;

  constructor() {
    this.cookieJar = new CookieJar();
    
    // SSL 검증 비활성화를 위한 https agent
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });

    // axios-cookiejar-support 대신 기본 axios 사용
    this.session = axios.create({
      withCredentials: true,
      httpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async login(username: string, password: string): Promise<boolean> {
    const loginUrl = `${this.baseUrl}/member/loginAction`;
    
    try {
      console.log("로그인 시도 중...");
      const resp = await this.session.post(loginUrl, new URLSearchParams({
        username: username,
        password: password
      }));
      
      console.log("응답 타입:", typeof resp.data);
      console.log("응답 내용:", resp.data);
      
      // 응답이 문자열인 경우
      if (typeof resp.data === 'string') {
        if (resp.data.includes("로그인 실패") || resp.data.includes("fail")) {
          console.log("❌ 로그인 실패");
          return false;
        }
      } 
      // 응답이 객체인 경우
      else if (typeof resp.data === 'object') {
        // 성공/실패 판단 (일반적인 응답 형식들)
        if (resp.data.success === false || resp.data.result === false || 
            resp.data.error || resp.data.message?.includes("실패")) {
          console.log("❌ 로그인 실패:", resp.data);
          return false;
        }
      }
      
      // 상태 코드로도 확인
      if (resp.status === 200 || resp.status === 302) {
        console.log("✅ 로그인 성공");
        return true;
      }
      
      console.log("⚠️ 로그인 응답 확인 필요");
      return false;
    } catch (error: any) {
      console.log(`❌ 로그인 오류: ${error.message}`);
      return false;
    }
  }

  async getTimeList(pickDate: string, cate2: number): Promise<TimeListResponse> {
    const url = `${this.baseUrl}/sports/reserve_time_pick`;
    
    const r = await this.session.post(url, new URLSearchParams({
      pickDate: pickDate,
      cate2: cate2.toString()
    }));
    
    return r.data;
  }

  async checkReserve(pickDate: string, cate2: number): Promise<CheckReserveResponse> {
    const url = `${this.baseUrl}/API`;

    try {
      const r = await this.session.post(url, new URLSearchParams({
        kd: 'A',
        useDayBegin: pickDate,
        cseq: cate2.toString()
      }));
      
      return r.data;
    } catch (error: any) {
      console.log(`check_reserve() 실패 (${pickDate}): ${error.message}`);
      return {};
    }
  }

  async crawlAvailableTimes(pickDate: string, cate2: number): Promise<CrawlRow[]> {
    console.log(`크롤링: ${pickDate}, cate2=${cate2}`);
    
    const result = await this.getTimeList(pickDate, cate2);
    const reserved = await this.checkReserve(pickDate, cate2);

    const reservedSet = new Set<string>();
    const reservedList = reserved.list || [];
    
    for (const r of reservedList) {
      let beginTime = r.useTimeBegin || "00:00";
      
      if (/^\d+$/.test(beginTime)) {
        beginTime = `${parseInt(beginTime).toString().padStart(2, '0')}:00`;
      }
      
      const key = `${r.cseq},${beginTime}`;
      reservedSet.add(key);
    }

    let courts: string[];
    let prefix: string;

    if (cate2 === 17) {
      courts = Array.from({ length: 4 }, (_, i) => `${i + 1}코트@${29 + i + 1}`);
      prefix = "2";
    } else if (cate2 === 15) {
      courts = Array.from({ length: 3 }, (_, i) => `${i + 1}코트@${17 + i + 1}`);
      prefix = "";
    } else {
      courts = Array.from({ length: 9 }, (_, i) => `${i + 1}코트@${20 + i + 1}`);
      prefix = "1";
    }

    const rows: CrawlRow[] = [];
    let startTime = result.useBeginHour;
    const hourUnit = result.hourUnit;
    const lineCount = parseInt(result.line);

    for (let i = 0; i < lineCount; i++) {
      const endTime = startTime + hourUnit;
      const startTxt = `${Math.floor(startTime).toString().padStart(2, '0')}:00`;
      const endTxt = `${Math.floor(endTime).toString().padStart(2, '0')}:00`;

      for (const c of courts) {
        const [courtName, courtSeq] = c.split('@');
        const key = `${courtSeq},${startTxt}`;
        const isReserved = reservedSet.has(key);
        const courtNum = prefix ? `${prefix}${courtName}` : courtName;

        rows.push({
          date: pickDate,
          court: courtNum,
          startTime: startTxt,
          endTime: endTxt,
          status: isReserved ? "예약불가" : "예약가능"
        });
      }

      startTime += hourUnit;
    }

    return rows;
  }

  async crawlMonth(year: number, month: number, delay: number = 0.5): Promise<MonthResults> {
    console.log(`${year}년 ${month}월 크롤링 시작...`);

    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);

    const allResults: MonthResults = {
      bul: [],
      ma: [],
      cho: []
    };

    const facilities: Array<[number, keyof MonthResults, string]> = [
      [15, 'bul', '불암산'],
      [16, 'ma', '마들'],
      [17, 'cho', '초안산']
    ];

    let currentDate = new Date(firstDay);
    
    while (currentDate <= lastDay) {
      const pickDate = currentDate.toISOString().split('T')[0];
      
      for (const [cate2Val, name, displayName] of facilities) {
        try {
          const rows = await this.crawlAvailableTimes(pickDate, cate2Val);
          allResults[name].push(...rows);
          console.log(`  ✅ ${pickDate} ${displayName}: ${rows.length}개 시간대`);
          
          if (delay > 0) {
            await this.sleep(delay * 1000);
          }
        } catch (error: any) {
          console.log(`  ❌ ${pickDate} ${displayName} 실패: ${error.message}`);
        }
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log("크롤링 완료!");
    return allResults;
  }

  generateCSV(results: MonthResults): string {
    const headers = ['날짜', '코트', '시작시간', '종료시간', '상태'];
    const rows = [headers.join(',')];

    const allData = [
      ...results.bul.map(r => ({ ...r, facility: '불암산' })),
      ...results.ma.map(r => ({ ...r, facility: '마들' })),
      ...results.cho.map(r => ({ ...r, facility: '초안산' }))
    ];

    allData.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.facility !== b.facility) return a.facility.localeCompare(b.facility);
      if (a.court !== b.court) return a.court.localeCompare(b.court);
      return a.startTime.localeCompare(b.startTime);
    });

    for (const row of allData) {
      rows.push([
        row.date,
        `${row.facility} ${row.court}`,
        row.startTime,
        row.endTime,
        row.status
      ].join(','));
    }

    return rows.join('\n');
  }

  generateAvailableOnlyCSV(results: MonthResults): string {
    const headers = ['날짜', '코트', '시작시간', '종료시간'];
    const rows = [headers.join(',')];

    const allData = [
      ...results.bul.map(r => ({ ...r, facility: '불암산' })),
      ...results.ma.map(r => ({ ...r, facility: '마들' })),
      ...results.cho.map(r => ({ ...r, facility: '초안산' }))
    ].filter(r => r.status === '예약가능');

    allData.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.facility !== b.facility) return a.facility.localeCompare(b.facility);
      if (a.court !== b.court) return a.court.localeCompare(b.court);
      return a.startTime.localeCompare(b.startTime);
    });

    for (const row of allData) {
      rows.push([
        row.date,
        `${row.facility} ${row.court}`,
        row.startTime,
        row.endTime
      ].join(','));
    }

    return rows.join('\n');
  }

  saveResults(results: MonthResults, outputDir: string = './output'): void {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(
      `${outputDir}/nowon_results.json`,
      JSON.stringify(results, null, 2),
      'utf8'
    );
    console.log(`📁 JSON 저장: ${outputDir}/nowon_results.json`);

    const csvAll = this.generateCSV(results);
    fs.writeFileSync(`${outputDir}/nowon_all.csv`, csvAll, 'utf8');
    console.log(`📁 전체 CSV 저장: ${outputDir}/nowon_all.csv`);

    const csvAvailable = this.generateAvailableOnlyCSV(results);
    fs.writeFileSync(`${outputDir}/nowon_available.csv`, csvAvailable, 'utf8');
    console.log(`📁 예약가능 CSV 저장: ${outputDir}/nowon_available.csv`);

    const totalSlots = results.bul.length + results.ma.length + results.cho.length;
    const availableSlots = [...results.bul, ...results.ma, ...results.cho]
      .filter(r => r.status === '예약가능').length;
    
    console.log(`\n📊 통계:`);
    console.log(`  전체 시간대: ${totalSlots}개`);
    console.log(`  예약 가능: ${availableSlots}개`);
    console.log(`  예약 불가: ${totalSlots - availableSlots}개`);
  }
}

// 실행
async function main() {
  const crawler = new NowonCrawler();

  const username = "leedk0121";  // 🔴 변경 필요
  const password = "dookoung1!!";  // 🔴 변경 필요

  const loginSuccess = await crawler.login(username, password);
  if (!loginSuccess) {
    console.log("로그인 실패. 프로그램 종료.");
    return;
  }

  console.log("\n=== 특정 날짜 조회 ===");
  const testDate = "2025-10-15";
  const testResults = await crawler.crawlAvailableTimes(testDate, 15);
  console.log(`${testDate} 결과: ${testResults.length}개`);
  console.log("처음 5개:", testResults.slice(0, 5));

  // 한 달 전체 크롤링 (주석 해제하여 사용)
  console.log("\n=== 한 달 크롤링 ===");
  const results = await crawler.crawlMonth(2025, 10, 0.5);
  crawler.saveResults(results);

  console.log("\n✅ 완료!");
}

main().catch(console.error);