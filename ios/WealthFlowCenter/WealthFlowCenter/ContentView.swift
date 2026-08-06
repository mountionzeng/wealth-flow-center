import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: StudyStore

    @State private var title = ""
    @State private var courseName = ""
    @State private var taskType: StudyTaskType = .course
    @State private var startDate = Date()
    @State private var endDate = Date().addingTimeInterval(3600)
    @State private var writeCalendar = true
    @State private var scheduleNotification = true

    private let calendarService = CalendarService()
    private let notificationService = NotificationService()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HeaderPanel()
                    ActivePanel()
                    MonthChart()
                    CreateQuestPanel(
                        title: $title,
                        courseName: $courseName,
                        taskType: $taskType,
                        startDate: $startDate,
                        endDate: $endDate,
                        writeCalendar: $writeCalendar,
                        scheduleNotification: $scheduleNotification,
                        onQuickDuration: applyQuickDuration,
                        onCreate: submitQuest
                    )
                    QuestList(onComplete: completeQuest, onDelete: deleteQuest)
                }
                .padding()
            }
            .background(AppBackground())
            .navigationTitle("财富流通中心")
            .iosInlineNavigationTitle()
            .alert("提示", isPresented: Binding(
                get: { store.lastError != nil },
                set: { if !$0 { store.lastError = nil } }
            )) {
                Button("知道了", role: .cancel) {}
            } message: {
                Text(store.lastError ?? "")
            }
        }
    }

    private func applyQuickDuration(_ minutes: Int) {
        startDate = Date()
        endDate = store.setDefaultEnd(from: startDate, minutes: minutes)
    }

    private func submitQuest() {
        guard let quest = store.createQuest(
            title: title,
            courseName: courseName,
            taskType: taskType,
            start: startDate,
            end: endDate
        ) else {
            return
        }

        if writeCalendar {
            Task {
                do {
                    let message = try await calendarService.addQuest(quest)
                    await MainActor.run {
                        store.updateCalendarStatus(for: quest.id, status: "done", message: message)
                    }
                } catch {
                    await MainActor.run {
                        store.updateCalendarStatus(for: quest.id, status: "failed", message: error.localizedDescription)
                    }
                }
            }
        } else {
            store.updateCalendarStatus(for: quest.id, status: "skipped", message: "未写入日历")
        }

        if scheduleNotification {
            Task {
                try? await notificationService.scheduleStudyReminder(for: quest)
            }
        }

        title = ""
        courseName = ""
        startDate = Date()
        endDate = store.setDefaultEnd(from: startDate, minutes: 60)
    }

    private func completeQuest(_ quest: StudyQuest) {
        store.complete(quest)
        notificationService.removeReminder(for: quest)
    }

    private func deleteQuest(_ quest: StudyQuest) {
        store.delete(quest)
        notificationService.removeReminder(for: quest)
    }
}

private struct HeaderPanel: View {
    @EnvironmentObject private var store: StudyStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("时间财富正在流通")
                .font(.title2.weight(.semibold))
            HStack(spacing: 12) {
                StatPill(title: "等级", value: "\(store.state.player.level)")
                StatPill(title: "财富值", value: "\(store.state.player.wealth)")
                StatPill(title: "连续学习", value: "\(store.state.player.streak)天")
            }
            ProgressView(
                value: Double(store.state.player.xp),
                total: Double(store.xpTarget(for: store.state.player.level))
            )
            .tint(.yellow)
        }
        .panelStyle()
    }
}

private struct ActivePanel: View {
    @EnvironmentObject private var store: StudyStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("学习提醒")
                .font(.headline)
            if let active = store.activeQuest {
                Text(active.displayTitle)
                    .font(.body.weight(.semibold))
                Text("本次学习到 \(StudyDateFormatters.displayTime.string(from: active.end)) 结束")
                    .foregroundStyle(.secondary)
            } else if let next = store.upcomingQuest {
                Text(next.displayTitle)
                    .font(.body.weight(.semibold))
                Text("下次学习 \(StudyDateFormatters.displayDay.string(from: next.start)) \(StudyDateFormatters.displayTime.string(from: next.start))")
                    .foregroundStyle(.secondary)
            } else {
                Text("暂无进行中或待开始的学习任务")
                    .foregroundStyle(.secondary)
            }
        }
        .panelStyle()
    }
}

private struct MonthChart: View {
    @EnvironmentObject private var store: StudyStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("最近一个月学习时长")
                .font(.headline)
            HStack(alignment: .bottom, spacing: 4) {
                let maxMinutes = max(store.monthlyMinutesByDay.map(\.minutes).max() ?? 1, 1)
                ForEach(Array(store.monthlyMinutesByDay.enumerated()), id: \.offset) { _, item in
                    RoundedRectangle(cornerRadius: 3)
                        .fill(LinearGradient(
                            colors: [.yellow.opacity(0.95), .orange.opacity(0.6)],
                            startPoint: .top,
                            endPoint: .bottom
                        ))
                        .frame(height: max(6, CGFloat(item.minutes) / CGFloat(maxMinutes) * 96))
                        .accessibilityLabel("\(StudyDateFormatters.displayDay.string(from: item.day)) \(item.minutes) 分钟")
                }
            }
            if !store.minutesByCourse.isEmpty {
                FlowRow(items: store.minutesByCourse.prefix(6).map { "\($0.name) \($0.minutes)m" })
            }
        }
        .panelStyle()
    }
}

private struct CreateQuestPanel: View {
    @Binding var title: String
    @Binding var courseName: String
    @Binding var taskType: StudyTaskType
    @Binding var startDate: Date
    @Binding var endDate: Date
    @Binding var writeCalendar: Bool
    @Binding var scheduleNotification: Bool

    let onQuickDuration: (Int) -> Void
    let onCreate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("创建学习任务")
                .font(.headline)

            TextField("课程，例如 CS520", text: $courseName)
                .courseCodeInputStyle()
                .textFieldStyle(RoundedBorderTextFieldStyle())

            TextField("任务标题", text: $title)
                .textFieldStyle(RoundedBorderTextFieldStyle())

            Picker("学习类型", selection: $taskType) {
                ForEach(StudyTaskType.allCases) { type in
                    Text(type.label).tag(type)
                }
            }
            .pickerStyle(.segmented)

            DatePicker("开始时间", selection: $startDate)
            DatePicker("结束时间", selection: $endDate)

            HStack {
                Button("学习40分钟") { onQuickDuration(40) }
                Button("学习一个小时") { onQuickDuration(60) }
            }
            .buttonStyle(.bordered)

            Toggle("写入苹果日历", isOn: $writeCalendar)
            Toggle("开始前本地提醒", isOn: $scheduleNotification)

            Button(action: onCreate) {
                Label("创建任务", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .panelStyle()
    }
}

private struct QuestList: View {
    @EnvironmentObject private var store: StudyStore

    let onComplete: (StudyQuest) -> Void
    let onDelete: (StudyQuest) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("任务与倒计时表")
                .font(.headline)
            if store.quests.isEmpty {
                Text("还没有学习任务")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(store.quests) { quest in
                    QuestRow(quest: quest, onComplete: onComplete, onDelete: onDelete)
                    Divider()
                }
            }
        }
        .panelStyle()
    }
}

private struct QuestRow: View {
    let quest: StudyQuest
    let onComplete: (StudyQuest) -> Void
    let onDelete: (StudyQuest) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(quest.taskType.tint)
                .frame(width: 10, height: 10)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 5) {
                Text(quest.displayTitle)
                    .font(.body.weight(.semibold))
                Text("\(StudyDateFormatters.displayDay.string(from: quest.start)) \(StudyDateFormatters.displayTime.string(from: quest.start))-\(StudyDateFormatters.displayTime.string(from: quest.end)) · \(quest.taskType.label)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !quest.calendarSyncMessage.isEmpty {
                    Text(quest.calendarSyncMessage)
                        .font(.caption2)
                        .foregroundStyle(quest.calendarSyncStatus == "failed" ? .red : .secondary)
                }
            }
            Spacer()
            if quest.isDone {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
            } else {
                Button {
                    onComplete(quest)
                } label: {
                    Image(systemName: "checkmark.circle")
                }
                .buttonStyle(.borderless)
            }
            Button(role: .destructive) {
                onDelete(quest)
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
        }
    }
}

private struct StatPill: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.headline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct FlowRow: View {
    let items: [String]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], spacing: 8) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.caption)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }
}

private struct AppBackground: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 1.0, green: 0.98, blue: 0.91),
                Color(red: 0.95, green: 0.98, blue: 1.0),
                Color(red: 1.0, green: 0.95, blue: 0.97)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }
}

private extension View {
    func panelStyle() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(.white.opacity(0.35), lineWidth: 1)
            }
    }

    @ViewBuilder
    func iosInlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    @ViewBuilder
    func courseCodeInputStyle() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.characters)
        #else
        self
        #endif
    }
}

struct ContentViewPreviews: PreviewProvider {
    static var previews: some View {
        ContentView()
            .environmentObject(StudyStore())
    }
}
