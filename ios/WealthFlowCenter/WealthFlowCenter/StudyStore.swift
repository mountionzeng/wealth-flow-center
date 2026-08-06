import Foundation

@MainActor
final class StudyStore: ObservableObject {
    @Published private(set) var state = StudyState()
    @Published var lastError: String?

    private let fileManager: FileManager
    private let calendar = Calendar.current

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
        load()
    }

    var quests: [StudyQuest] {
        state.quests.sorted { $0.start > $1.start }
    }

    var activeQuest: StudyQuest? {
        let now = Date()
        return state.quests
            .filter { !$0.isDone && $0.start <= now && $0.end >= now }
            .sorted { $0.end < $1.end }
            .first
    }

    var upcomingQuest: StudyQuest? {
        let now = Date()
        return state.quests
            .filter { !$0.isDone && $0.start > now }
            .sorted { $0.start < $1.start }
            .first
    }

    var monthlyMinutesByDay: [(day: Date, minutes: Int)] {
        let today = calendar.startOfDay(for: Date())
        let days = (0..<30).compactMap { offset in
            calendar.date(byAdding: .day, value: -29 + offset, to: today)
        }
        return days.map { day in
            let minutes = state.quests
                .filter { $0.isDone && calendar.isDate($0.start, inSameDayAs: day) }
                .reduce(0) { $0 + $1.durationMinutes }
            return (day, minutes)
        }
    }

    var minutesByCourse: [(name: String, minutes: Int)] {
        let cutoff = calendar.date(byAdding: .day, value: -30, to: Date()) ?? Date()
        let grouped = Dictionary(grouping: state.quests.filter { $0.isDone && $0.start >= cutoff }) {
            $0.courseName.isEmpty ? "未命名课程" : $0.courseName
        }
        return grouped
            .map { (name: $0.key, minutes: $0.value.reduce(0) { $0 + $1.durationMinutes }) }
            .sorted { $0.minutes > $1.minutes }
    }

    func createQuest(
        title: String,
        courseName: String,
        taskType: StudyTaskType,
        start: Date,
        end: Date
    ) -> StudyQuest? {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty, end > start else {
            lastError = "请填写标题，并确保结束时间晚于开始时间。"
            return nil
        }

        let minutes = max(Int(end.timeIntervalSince(start) / 60), 10)
        let quest = StudyQuest(
            id: state.nextID,
            title: cleanTitle,
            courseName: courseName.trimmingCharacters(in: .whitespacesAndNewlines),
            taskType: taskType,
            start: start,
            end: end,
            durationMinutes: minutes,
            rewardXP: rewardXP(minutes: minutes, taskType: taskType),
            rewardWealth: rewardWealth(minutes: minutes, taskType: taskType),
            status: .todo,
            createdAt: Date(),
            completedAt: nil,
            calendarSyncStatus: "pending",
            calendarSyncMessage: ""
        )
        state.nextID += 1
        state.quests.append(quest)
        save()
        return quest
    }

    func updateCalendarStatus(for questID: Int, status: String, message: String) {
        guard let index = state.quests.firstIndex(where: { $0.id == questID }) else { return }
        state.quests[index].calendarSyncStatus = status
        state.quests[index].calendarSyncMessage = message
        save()
    }

    func complete(_ quest: StudyQuest) {
        guard let index = state.quests.firstIndex(where: { $0.id == quest.id }) else { return }
        guard !state.quests[index].isDone else { return }

        let completedAt = Date()
        state.quests[index].status = .done
        state.quests[index].completedAt = completedAt
        state.player.xp += state.quests[index].rewardXP
        state.player.wealth += state.quests[index].rewardWealth
        state.player.totalDone += 1
        state.player.totalMinutes += state.quests[index].durationMinutes
        updateStreak(completedAt: completedAt)
        levelUpIfNeeded()
        save()
    }

    func delete(_ quest: StudyQuest) {
        state.quests.removeAll { $0.id == quest.id }
        save()
    }

    func setDefaultEnd(from start: Date, minutes: Int) -> Date {
        calendar.date(byAdding: .minute, value: minutes, to: start) ?? start.addingTimeInterval(TimeInterval(minutes * 60))
    }

    func load() {
        do {
            let url = try stateURL()
            guard fileManager.fileExists(atPath: url.path) else {
                state = StudyState()
                return
            }
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .formatted(StudyDateFormatters.taskDateTime)
            state = try decoder.decode(StudyState.self, from: data)
        } catch {
            lastError = "读取本地数据失败：\(error.localizedDescription)"
            state = StudyState()
        }
    }

    private func save() {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            encoder.dateEncodingStrategy = .formatted(StudyDateFormatters.taskDateTime)
            let data = try encoder.encode(state)
            try data.write(to: stateURL(), options: [.atomic])
        } catch {
            lastError = "保存本地数据失败：\(error.localizedDescription)"
        }
    }

    private func stateURL() throws -> URL {
        let folder = try fileManager.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return folder.appendingPathComponent("study_state.json")
    }

    private func rewardXP(minutes: Int, taskType: StudyTaskType) -> Int {
        max(Int((Double(minutes) / 10.0 * taskType.xpMultiplier).rounded()), 1)
    }

    private func rewardWealth(minutes: Int, taskType: StudyTaskType) -> Int {
        max(Int((Double(minutes) / 20.0 * taskType.wealthMultiplier).rounded()), 1)
    }

    private func updateStreak(completedAt: Date) {
        let completedDay = calendar.startOfDay(for: completedAt)
        guard let lastCompletedDate = state.player.lastCompletedDate else {
            state.player.streak = 1
            state.player.lastCompletedDate = completedDay
            return
        }

        let lastDay = calendar.startOfDay(for: lastCompletedDate)
        if calendar.isDate(completedDay, inSameDayAs: lastDay) {
            state.player.lastCompletedDate = completedDay
            return
        }

        if let yesterday = calendar.date(byAdding: .day, value: -1, to: completedDay),
           calendar.isDate(yesterday, inSameDayAs: lastDay) {
            state.player.streak += 1
        } else {
            state.player.streak = 1
        }
        state.player.lastCompletedDate = completedDay
    }

    private func levelUpIfNeeded() {
        while state.player.xp >= xpTarget(for: state.player.level) {
            state.player.xp -= xpTarget(for: state.player.level)
            state.player.level += 1
        }
    }

    func xpTarget(for level: Int) -> Int {
        80 + max(level - 1, 0) * 30
    }
}
